use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrRequest {
  pub image_base64: Option<String>,
  pub mode: Option<String>,
  pub language: Option<String>,
  pub api_url: Option<String>,
  pub api_key: Option<String>,
  pub action: Option<String>,
  pub pdf_path: Option<String>,
  pub output_path: Option<String>,
  pub tier: Option<String>,
  pub write_text_layer: Option<bool>,
  pub page_offset: Option<i32>,
}

fn find_python() -> String {
  for candidate in ["python", "python3", "py"] {
    if Command::new(candidate)
      .arg("--version")
      .output()
      .map(|o| o.status.success())
      .unwrap_or(false)
    {
      return candidate.to_string();
    }
  }
  "python".to_string()
}

fn resolve_ocr_script(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  let cwd = std::env::current_dir().unwrap_or_default();
  // 开发时优先用仓库内脚本，避免仍跑到 target 里过期的打包副本
  let mut candidates = vec![
    cwd.join("python-ocr").join("ocr_engine.py"),
    cwd.join("..").join("python-ocr").join("ocr_engine.py"),
    cwd
      .join("..")
      .join("..")
      .join("python-ocr")
      .join("ocr_engine.py"),
  ];
  if let Ok(resource_dir) = app.path().resource_dir() {
    candidates.push(resource_dir.join("python-ocr").join("ocr_engine.py"));
  }
  for path in candidates {
    if path.exists() {
      return Ok(path);
    }
  }
  Err("未找到 python-ocr/ocr_engine.py，请确认项目结构完整".into())
}

fn strip_ansi(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  let mut chars = s.chars().peekable();
  while let Some(c) = chars.next() {
    if c == '\u{1b}' {
      if chars.peek() == Some(&'[') {
        chars.next();
        while let Some(n) = chars.next() {
          if n.is_ascii_alphabetic() {
            break;
          }
        }
      }
      continue;
    }
    out.push(c);
  }
  out
}

/// 从 Python 侧车的 stdout 中提取 JSON 结果。
///
/// Paddle 的 C++ 日志会直接写 fd 1（绕过 Python 的 sys.stdout 重定向），
/// 因此 stdout 可能是「若干日志行 + 末尾一行 JSON」。不能简单地用 rfind('{')
/// 截取——结果的 words/pages 是嵌套对象，最后一个 '{' 往往属于嵌套项。
fn extract_json_from_stdout(stdout: &str) -> Result<serde_json::Value, String> {
  let trimmed = stdout.trim();
  if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
    return Ok(value);
  }

  // 逐个 '{' 尝试流式解析（只读一个值，容忍 JSON 前后粘连日志）。
  // 结果对象一定带 "mode" 字段，借此跳过日志里顺带出现的其它 JSON。
  for (idx, _) in trimmed.match_indices('{') {
    let mut de = serde_json::Deserializer::from_str(&trimmed[idx..]);
    if let Ok(value) = serde_json::Value::deserialize(&mut de) {
      if value.is_object() && value.get("mode").is_some() {
        return Ok(value);
      }
    }
  }

  Err("stdout 中未找到合法 JSON".to_string())
}

#[derive(Default)]
struct OcrProcessState {
  child: Mutex<Option<Child>>,
}

/// IDE/系统常残留失效本地代理，会导致 Paddle 模型下载全部走 ProxyError。
fn strip_proxy_env(command: &mut Command) {
  for key in [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "SOCKS_PROXY",
    "socks_proxy",
    "SOCKS5_PROXY",
    "socks5_proxy",
  ] {
    command.env_remove(key);
  }
  command.env("NO_PROXY", "*").env("no_proxy", "*");
}

fn build_python_ocr_command(app: &AppHandle) -> Result<(Command, String), String> {
  let script = resolve_ocr_script(app)?;
  let python = find_python();
  let mut command = Command::new(&python);
  command
    .arg(&script)
    .arg("--stdin-json")
    .env("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    .env("PADDLE_PDX_MODEL_SOURCE", "bos")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  strip_proxy_env(&mut command);
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
  }
  Ok((command, python))
}

fn parse_ocr_progress_line(line: &str) -> Option<serde_json::Value> {
  const PREFIX: &str = "__OCR_PROGRESS__";
  let trimmed = line.trim();
  let json = trimmed.strip_prefix(PREFIX)?;
  serde_json::from_str::<serde_json::Value>(json).ok()
}

fn kill_ocr_child(ocr_state: &OcrProcessState) {
  if let Ok(mut slot) = ocr_state.child.lock() {
    if let Some(mut child) = slot.take() {
      let _ = child.kill();
      let _ = child.wait();
    }
  }
}

fn run_python_ocr(
  app: &AppHandle,
  request: &OcrRequest,
  ocr_state: &OcrProcessState,
) -> Result<serde_json::Value, String> {
  // 新任务开始前清掉残留进程，避免双实例
  kill_ocr_child(ocr_state);

  let payload = serde_json::to_string(request).map_err(|e| e.to_string())?;
  let (mut command, _python) = build_python_ocr_command(app)?;

  let mut child = command
    .spawn()
    .map_err(|e| format!("启动 Python OCR 失败: {e}"))?;

  if let Some(mut stdin) = child.stdin.take() {
    stdin
      .write_all(payload.as_bytes())
      .map_err(|e| format!("写入 OCR 请求失败: {e}"))?;
  }

  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "无法捕获 OCR stdout".to_string())?;
  let stderr = child
    .stderr
    .take()
    .ok_or_else(|| "无法捕获 OCR stderr".to_string())?;

  {
    let mut slot = ocr_state
      .child
      .lock()
      .map_err(|_| "OCR 状态锁损坏".to_string())?;
    *slot = Some(child);
  }

  let app_progress = app.clone();
  let stderr_thread = thread::spawn(move || {
    let mut err_buf = String::new();
    let reader = BufReader::new(stderr);
    for line in reader.lines().flatten() {
      if let Some(progress) = parse_ocr_progress_line(&line) {
        let _ = app_progress.emit("ocr-progress", progress);
      } else {
        if !err_buf.is_empty() {
          err_buf.push('\n');
        }
        err_buf.push_str(&strip_ansi(&line));
      }
    }
    err_buf
  });

  let stdout_thread = thread::spawn(move || {
    let mut out = String::new();
    let mut reader = BufReader::new(stdout);
    let _ = reader.read_to_string(&mut out);
    out
  });

  // 用 try_wait 轮询，期间释放锁，便于 cancel_ocr 取走并 kill
  let wait_status = loop {
    thread::sleep(std::time::Duration::from_millis(40));
    let mut slot = ocr_state
      .child
      .lock()
      .map_err(|_| "OCR 状态锁损坏".to_string())?;
    match slot.as_mut() {
      None => break Err("OCR 已取消".to_string()),
      Some(child) => match child.try_wait() {
        Ok(Some(status)) => {
          *slot = None;
          break Ok(status);
        }
        Ok(None) => {}
        Err(e) => {
          *slot = None;
          break Err(format!("等待 OCR 进程失败: {e}"));
        }
      },
    }
  };

  let stdout = stdout_thread.join().unwrap_or_default();
  let stderr_text = stderr_thread.join().unwrap_or_default();

  let status = wait_status?;
  if !status.success() {
    let code = status.code().unwrap_or(-1);
    if stderr_text.contains("OCR 已取消") {
      return Err("OCR 已取消".into());
    }
    let err = if stderr_text.trim().is_empty() {
      format!("OCR 执行失败（退出码 {code}）")
    } else {
      format!("OCR 执行失败: {stderr_text}")
    };
    return Err(err);
  }

  extract_json_from_stdout(&stdout).map_err(|e| {
    format!("解析 OCR 结果失败: {e}\nstdout: {stdout}\nstderr: {stderr_text}")
  })
}

/// 全书 / 单页 OCR 可能长达数分钟；放到 blocking 线程池，避免卡住 UI 主线程。
#[tauri::command]
async fn run_ocr(app: AppHandle, request: OcrRequest) -> Result<serde_json::Value, String> {
  let app_for_job = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app_for_job.state::<OcrProcessState>();
    run_python_ocr(&app_for_job, &request, state.inner())
  })
  .await
  .map_err(|e| format!("OCR 任务中断: {e}"))?
}

#[tauri::command]
fn cancel_ocr(ocr_state: State<'_, OcrProcessState>) -> Result<(), String> {
  kill_ocr_child(ocr_state.inner());
  Ok(())
}

fn probe_ocr_backends_via_script(app: &AppHandle) -> Option<serde_json::Value> {
  let script = resolve_ocr_script(app).ok()?;
  let python = find_python();
  let mut command = Command::new(&python);
  command
    .arg(&script)
    .arg("--probe")
    .env("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    .env("PADDLE_PDX_MODEL_SOURCE", "bos")
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  strip_proxy_env(&mut command);
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
  }
  let output = command.output().ok()?;
  if !output.status.success() {
    return None;
  }
  let stdout = String::from_utf8_lossy(&output.stdout);
  serde_json::from_str::<serde_json::Value>(stdout.trim()).ok()
}

#[tauri::command]
fn detect_ocr_backends(app: AppHandle) -> serde_json::Value {
  let python = find_python();
  if let Some(mut probed) = probe_ocr_backends_via_script(&app) {
    if let Some(obj) = probed.as_object_mut() {
      obj.insert("python".into(), serde_json::json!(python));
      obj.entry("onlineReady".to_string())
        .or_insert(serde_json::json!(true));
    }
    return probed;
  }

  let paddle_ok = Command::new(&python)
    .args(["-c", "from paddleocr import PaddleOCR; print('ok')"])
    .output()
    .map(|o| o.status.success())
    .unwrap_or(false);

  serde_json::json!({
    "python": python,
    "offlineReady": paddle_ok,
    "onlineReady": true,
    "engine": if paddle_ok { "PP-OCRv6" } else { "none" },
    "gpuAvailable": false,
    "device": "cpu"
  })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCliRequest {
  pub program: String,
  pub args: Option<Vec<String>>,
  pub prompt: String,
  pub provider: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCliResponse {
  pub stdout: String,
  pub stderr: String,
  pub code: i32,
}

fn is_safe_ai_program(program: &str) -> bool {
  let p = program.trim();
  if p.is_empty() {
    return false;
  }
  // 绝对路径：允许用户显式指定
  if p.contains('/') || p.contains('\\') || (p.len() >= 2 && p.as_bytes()[1] == b':') {
    return std::path::Path::new(p).is_absolute();
  }
  // 仅白名单短名
  matches!(p.to_ascii_lowercase().as_str(), "claude" | "codex" | "claude.exe" | "codex.exe")
}

#[cfg(windows)]
fn windows_program_extensions(name: &str) -> &'static [&'static str] {
  let lower = name.to_ascii_lowercase();
  if [".exe", ".com", ".cmd", ".bat"]
    .iter()
    .any(|ext| lower.ends_with(ext))
  {
    &[""]
  } else {
    // 优先真正的可执行文件，其次才是 npm 生成的 .cmd/.bat shim
    &[".exe", ".com", ".cmd", ".bat"]
  }
}

#[cfg(windows)]
fn find_windows_on_path(name: &str) -> Option<std::path::PathBuf> {
  let extensions = windows_program_extensions(name);
  let path_var = std::env::var_os("PATH")?;
  for dir in std::env::split_paths(&path_var) {
    // 跳过空项，避免从当前工作目录意外启动同名程序
    if dir.as_os_str().is_empty() {
      continue;
    }
    for ext in extensions {
      let candidate = dir.join(format!("{name}{ext}"));
      if candidate.is_file() {
        return Some(candidate);
      }
    }
  }
  None
}

#[cfg(windows)]
fn windows_fallback_dirs() -> Vec<std::path::PathBuf> {
  let mut dirs = Vec::new();
  if let Some(appdata) = std::env::var_os("APPDATA") {
    dirs.push(std::path::PathBuf::from(appdata).join("npm"));
  }
  if let Some(home) = std::env::var_os("USERPROFILE") {
    // Claude Code 官方安装脚本（PowerShell）的默认位置
    dirs.push(std::path::PathBuf::from(home).join(".local").join("bin"));
  }
  dirs
}

#[cfg(windows)]
fn resolve_windows_program(program: &str) -> Result<std::path::PathBuf, String> {
  let path = std::path::Path::new(program);
  if path.is_absolute() {
    // 用户可能粘贴了 npm 目录里无扩展名的 POSIX 脚本；同目录的 .cmd 才是 Windows 入口
    if path.extension().is_none() {
      let mut candidate = path.as_os_str().to_os_string();
      candidate.push(".cmd");
      let with_cmd = std::path::PathBuf::from(candidate);
      if with_cmd.is_file() {
        return Ok(with_cmd);
      }
    }
    if path.is_file() {
      return Ok(path.to_path_buf());
    }
    return Err(format!("找不到可执行文件：{}", path.display()));
  }

  if let Some(found) = find_windows_on_path(program) {
    return Ok(found);
  }
  for dir in windows_fallback_dirs() {
    for ext in windows_program_extensions(program) {
      let candidate = dir.join(format!("{program}{ext}"));
      if candidate.is_file() {
        return Ok(candidate);
      }
    }
  }

  Err(format!(
    "未找到可执行文件「{program}」。请先安装 Claude Code / Codex CLI 并确认已加入 PATH，\
或在「设置 → AI」的 CLI 路径中填写 claude.exe / claude.cmd 的绝对路径。"
  ))
}

#[cfg(windows)]
fn quote_cmd_arg(arg: &str) -> String {
  // cmd 本身不识别反斜杠转义；这里生成交给 cmd 的命令行，
  // 内层引号用 \" 保留给最终的 Node 程序解析。
  format!("\"{}\"", arg.replace('"', "\\\""))
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn build_ai_cli_command(program: &str, args: &[String]) -> Result<Command, String> {
  use std::os::windows::process::CommandExt;

  let resolved = resolve_windows_program(program)?;
  let is_batch = resolved
    .extension()
    .and_then(|ext| ext.to_str())
    .map(|ext| {
      let lower = ext.to_ascii_lowercase();
      lower == "cmd" || lower == "bat"
    })
    .unwrap_or(false);

  if !is_batch {
    let mut command = Command::new(resolved);
    command.args(args).creation_flags(CREATE_NO_WINDOW);
    return Ok(command);
  }

  // .cmd/.bat 不能由 CreateProcess 直接执行，必须交给 cmd.exe。
  // Prompt 一律走 stdin，因此这里只有少量参数，不会触碰 cmd 的 8K 行长限制。
  let mut inner = quote_cmd_arg(&resolved.to_string_lossy());
  for arg in args {
    inner.push(' ');
    inner.push_str(&quote_cmd_arg(arg));
  }
  let comspec = std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into());
  let mut command = Command::new(comspec);
  command
    .arg("/D")
    .arg("/S")
    .arg("/C")
    .creation_flags(CREATE_NO_WINDOW);
  // 整段命令行原样交给 cmd，不能再套一层 MSVCRT 引号规则
  command.raw_arg(format!("\"{inner}\""));
  Ok(command)
}

#[cfg(not(windows))]
fn build_ai_cli_command(program: &str, args: &[String]) -> Result<Command, String> {
  let mut command = Command::new(program);
  command.args(args);
  Ok(command)
}

#[tauri::command]
fn run_ai_cli(request: AiCliRequest) -> Result<AiCliResponse, String> {
  let program = request.program.trim().to_string();
  if !is_safe_ai_program(&program) {
    return Err(format!(
      "不允许的 CLI：{program}。请使用 claude / codex，或填写绝对路径。"
    ));
  }

  let mut args = request.args.unwrap_or_default();
  let provider = request
    .provider
    .as_deref()
    .unwrap_or("")
    .to_ascii_lowercase();
  // Claude Code 与 Codex 都从 stdin 读取 prompt，避免长文档
  // （整本书的正文 + 历史对话）触发 Windows 命令行长度上限，也避免引号转义问题。
  if provider == "codex" {
    // codex exec -  ← 从 stdin 读取
    if !args.iter().any(|a| a == "exec") {
      args.insert(0, "exec".into());
    }
    // PDF 阅读器的工作目录通常不是 Git 仓库；不跳过检查会让默认调用直接失败
    if !args.iter().any(|a| a == "--skip-git-repo-check") {
      args.push("--skip-git-repo-check".into());
    }
    // 只做文本生成：默认 read-only，禁止改文件/联网；用户显式指定沙箱时不覆盖
    let explicit_sandbox = args.iter().any(|a| {
      a == "--sandbox"
        || a == "-s"
        || a.starts_with("--sandbox=")
        || a == "--full-auto"
        || a == "--yolo"
        || a == "--dangerously-bypass-approvals-and-sandbox"
    });
    if !explicit_sandbox {
      args.push("--sandbox".into());
      args.push("read-only".into());
    }
    args.push("-".into());
  } else if !args.iter().any(|a| a == "-p" || a == "--print") {
    // claude -p，prompt 通过 stdin 传入
    args.push("-p".into());
  }

  let mut command = build_ai_cli_command(&program, &args)?;
  command
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());

  let mut child = command
    .spawn()
    .map_err(|e| format!("启动 AI CLI 失败（{program}）: {e}"))?;

  // 在独立线程写入 stdin，主线程用 wait_with_output 持续读取 stdout/stderr，
  // 防止双方管道缓冲区写满后互相等待造成死锁。
  let writer = child.stdin.take().map(|mut stdin| {
    let payload = request.prompt.clone();
    std::thread::spawn(move || {
      use std::io::Write;
      stdin
        .write_all(payload.as_bytes())
        .and_then(|_| stdin.flush())
    })
  });

  let output = child
    .wait_with_output()
    .map_err(|e| format!("等待 AI CLI 输出失败（{program}）: {e}"))?;

  if let Some(handle) = writer {
    match handle.join() {
      Ok(Ok(())) => {}
      // CLI 自身报错时优先把 stderr 原样交给前端；只有进程成功但输入没写完
      // 才是真正的调用失败。
      Ok(Err(e)) if output.status.success() => {
        return Err(format!("写入 AI CLI 标准输入失败（{program}）: {e}"));
      }
      Err(_) if output.status.success() => {
        return Err(format!("写入 AI CLI 标准输入失败（{program}）"));
      }
      _ => {}
    }
  }

  Ok(AiCliResponse {
    stdout: strip_ansi(&String::from_utf8_lossy(&output.stdout)),
    stderr: strip_ansi(&String::from_utf8_lossy(&output.stderr)),
    code: output.status.code().unwrap_or(-1),
  })
}

/// AI 网络请求的直连回退通道。
///
/// tauri-plugin-http 默认跟随系统代理，但它把 reqwest 的错误压缩成一句
/// `error sending request for url (...)`，且没有暴露“绕过系统代理”的选项。
/// 当系统代理已失效（常见于 Clash 等工具重启、端口变化）时，前端会得到
/// 一个无法操作的网络错误。这里用同一套 TLS 栈直接发起请求：
/// - 可以显式 `.no_proxy()`，完全绕过环境变量与 Windows 系统代理；
/// - 通过 Channel 逐块回传响应，保留流式输出；
/// - 返回完整错误链，便于定位 DNS / TCP / TLS / 代理问题。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiHttpRequest {
  request_id: String,
  method: String,
  url: String,
  headers: Vec<(String, String)>,
  body: Option<String>,
  proxy: Option<AiHttpProxy>,
  connect_timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiHttpProxy {
  /// system | direct | custom
  mode: String,
  url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum AiHttpEvent {
  Headers {
    status: u16,
    status_text: String,
    url: String,
    headers: Vec<(String, String)>,
  },
  Chunk {
    /// base64：避免把二进制块展开成 JSON 数字数组
    data: String,
  },
  Done,
  Error {
    message: String,
  },
}

#[derive(Default)]
struct AiHttpState {
  cancels: std::sync::Mutex<
    std::collections::HashMap<String, futures_util::future::AbortHandle>,
  >,
}

fn describe_reqwest_error(error: &reqwest::Error) -> String {
  let mut parts = vec![error.to_string()];
  let mut source = std::error::Error::source(error);
  while let Some(cause) = source {
    let text = cause.to_string();
    if !text.is_empty() && !parts.iter().any(|part| part == &text) {
      parts.push(text);
    }
    source = cause.source();
  }
  parts.join("；")
}

fn build_ai_http_client(
  proxy: Option<&AiHttpProxy>,
  connect_timeout_ms: Option<u64>,
) -> Result<reqwest::Client, String> {
  let mut builder = reqwest::Client::builder()
    .user_agent(concat!("PDF-View/", env!("CARGO_PKG_VERSION")))
    .connect_timeout(std::time::Duration::from_millis(
      connect_timeout_ms.unwrap_or(20_000),
    ));
  match proxy.map(|value| value.mode.as_str()).unwrap_or("system") {
    // 关闭自动系统代理，同时忽略 HTTP(S)_PROXY 环境变量
    "direct" => builder = builder.no_proxy(),
    "custom" => {
      let url = proxy
        .and_then(|value| value.url.as_deref())
        .unwrap_or("")
        .trim();
      if url.is_empty() {
        return Err("自定义代理缺少地址".into());
      }
      let proxy = reqwest::Proxy::all(url)
        .map_err(|error| format!("代理地址无效（{url}）: {error}"))?;
      // 显式 proxy 会自动停用系统代理，避免两套代理叠加
      builder = builder.proxy(proxy);
    }
    "system" | "" => {}
    other => return Err(format!("未知的代理模式: {other}")),
  }
  builder
    .build()
    .map_err(|error| format!("创建 HTTP 客户端失败: {error}"))
}

async fn run_ai_http_request(
  request: AiHttpRequest,
  on_event: tauri::ipc::Channel<AiHttpEvent>,
) -> Result<(), String> {
  use base64::Engine as _;
  use futures_util::StreamExt as _;

  let url = reqwest::Url::parse(&request.url)
    .map_err(|error| format!("无效的请求地址（{}）: {error}", request.url))?;
  if !matches!(url.scheme(), "http" | "https") {
    return Err(format!("仅支持 http/https 请求，收到: {}", url.scheme()));
  }
  let method = reqwest::Method::from_bytes(request.method.as_bytes())
    .map_err(|error| format!("无效的 HTTP 方法: {error}"))?;
  let client = build_ai_http_client(request.proxy.as_ref(), request.connect_timeout_ms)?;

  let mut builder = client.request(method, url);
  if !request.headers.is_empty() {
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &request.headers {
      let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
        .map_err(|error| format!("无效的请求头名称（{name}）: {error}"))?;
      let header_value = reqwest::header::HeaderValue::from_bytes(value.as_bytes())
        .map_err(|error| format!("无效的请求头内容（{name}）: {error}"))?;
      headers.append(header_name, header_value);
    }
    builder = builder.headers(headers);
  }
  if let Some(body) = request.body {
    // AI 请求体始终是 UTF-8 的 JSON（或纯文本提示词）
    builder = builder.body(body.into_bytes());
  }

  let response = builder
    .send()
    .await
    .map_err(|error| format!("请求发送失败: {}", describe_reqwest_error(&error)))?;

  let status = response.status();
  let response_headers = response
    .headers()
    .iter()
    .map(|(name, value)| {
      (
        name.as_str().to_string(),
        String::from_utf8_lossy(value.as_bytes()).to_string(),
      )
    })
    .collect::<Vec<_>>();
  let response_url = response.url().to_string();
  on_event
    .send(AiHttpEvent::Headers {
      status: status.as_u16(),
      status_text: status.canonical_reason().unwrap_or("").to_string(),
      url: response_url,
      headers: response_headers,
    })
    .map_err(|error| format!("向界面回传响应头失败: {error}"))?;

  let mut stream = response.bytes_stream();
  while let Some(chunk) = stream.next().await {
    match chunk {
      Ok(bytes) => {
        if bytes.is_empty() {
          continue;
        }
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        on_event
          .send(AiHttpEvent::Chunk { data })
          .map_err(|error| format!("向界面回传响应数据失败: {error}"))?;
      }
      Err(error) => {
        let message = format!("读取响应失败: {}", describe_reqwest_error(&error));
        let _ = on_event.send(AiHttpEvent::Error {
          message: message.clone(),
        });
        return Err(message);
      }
    }
  }

  on_event
    .send(AiHttpEvent::Done)
    .map_err(|error| format!("向界面回传完成事件失败: {error}"))?;
  Ok(())
}

#[tauri::command]
async fn ai_http_stream(
  request: AiHttpRequest,
  on_event: tauri::ipc::Channel<AiHttpEvent>,
  state: tauri::State<'_, AiHttpState>,
) -> Result<(), String> {
  let request_id = request.request_id.clone();
  let (abort_handle, abort_registration) =
    futures_util::future::AbortHandle::new_pair();
  {
    let mut cancels = state
      .cancels
      .lock()
      .map_err(|_| "请求状态锁已损坏".to_string())?;
    // 同 id 的旧请求直接取消，避免资源泄漏
    if let Some(previous) = cancels.insert(request_id.clone(), abort_handle) {
      previous.abort();
    }
  }
  let result = futures_util::future::Abortable::new(
    run_ai_http_request(request, on_event),
    abort_registration,
  )
  .await;
  if let Ok(mut cancels) = state.cancels.lock() {
    cancels.remove(&request_id);
  }
  match result {
    Ok(result) => result,
    Err(_) => Err("请求已取消".into()),
  }
}

#[tauri::command]
fn ai_http_cancel(
  request_id: String,
  state: tauri::State<'_, AiHttpState>,
) -> Result<(), String> {
  let mut cancels = state
    .cancels
    .lock()
    .map_err(|_| "请求状态锁已损坏".to_string())?;
  if let Some(handle) = cancels.remove(&request_id) {
    handle.abort();
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    // 通过 Rust 发起 AI API 请求，绕过 WebView 的 CORS 限制
    .plugin(tauri_plugin_http::init())
    // 系统代理失效时的直连回退与请求取消状态
    .manage(AiHttpState::default())
    .manage(OcrProcessState::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      run_ocr,
      cancel_ocr,
      detect_ocr_backends,
      run_ai_cli,
      ai_http_stream,
      ai_http_cancel
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

#[cfg(test)]
mod tests {
  use super::extract_json_from_stdout;

  #[test]
  fn parses_clean_stdout() {
    let stdout = r#"{"text":"hello","words":[],"mode":"offline","engine":"PP-OCRv6"}"#;
    let value = extract_json_from_stdout(stdout).expect("clean stdout should parse");
    assert_eq!(value["mode"], "offline");
  }

  #[test]
  fn skips_native_log_lines_and_nested_braces() {
    let stdout = concat!(
      "ReduceMeanCheckIfOneDNNSupport\n",
      "I1023 11:08:57 onednn_context.cc:81] oneDNN v3.6.2\n",
      r#"{"text":"a\nb","words":[{"text":"a","x0":0.0,"y0":0.0,"x1":1.0,"y1":1.0},{"text":"b","x0":0.0,"y0":2.0,"x1":1.0,"y1":3.0}],"mode":"offline","engine":"PP-OCRv6"}"#
    );
    let value = extract_json_from_stdout(stdout).expect("polluted stdout should parse");
    assert_eq!(value["mode"], "offline");
    assert_eq!(value["words"].as_array().map(|w| w.len()), Some(2));
    assert_eq!(value["words"][1]["text"], "b");
  }

  #[test]
  fn tolerates_trailing_garbage_after_json() {
    let stdout = concat!(
      "log before\n",
      r#"{"text":"a","words":[{"text":"a","x0":0.0,"y0":0.0,"x1":1.0,"y1":1.0}],"mode":"offline"}"#,
      "trailing junk from native code"
    );
    let value = extract_json_from_stdout(stdout).expect("trailing garbage should be ignored");
    assert_eq!(value["text"], "a");
    assert_eq!(value["words"].as_array().map(|w| w.len()), Some(1));
  }
}

#[cfg(all(test, windows))]
mod cli_tests {
  use super::build_ai_cli_command;
  use std::io::Write;
  use std::process::Stdio;

  /// npm 安装的 claude/codex 在 Windows 上是 .cmd shim，必须经 cmd.exe 启动。
  /// 这个测试覆盖：带空格的路径、空参数、带空格参数、stdin 透传。
  #[test]
  fn launches_cmd_shim_with_args_and_stdin() {
    let node_ok = std::process::Command::new("node")
      .arg("--version")
      .output()
      .map(|o| o.status.success())
      .unwrap_or(false);
    if !node_ok {
      eprintln!("node not available, skipping cmd shim test");
      return;
    }

    let dir = std::env::temp_dir().join(format!("pdf view cli test {}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    std::fs::write(
      dir.join("echo_args.js"),
      "let d='';process.stdin.setEncoding('utf8');\
process.stdin.on('data',c=>d+=c);\
process.stdin.on('end',()=>console.log(JSON.stringify({argv:process.argv.slice(2),stdin:d})))",
    )
    .expect("write js");
    let shim = dir.join("echo_args.cmd");
    std::fs::write(&shim, "@echo off\r\nnode \"%~dp0echo_args.js\" %*\r\n").expect("write cmd");

    let args = vec![
      "-p".to_string(),
      "--tools".to_string(),
      String::new(),
      "a b".to_string(),
    ];
    let mut command =
      build_ai_cli_command(shim.to_str().expect("utf-8 path"), &args).expect("build command");
    let mut child = command
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .expect("spawn shim");
    child
      .stdin
      .take()
      .expect("stdin")
      .write_all("hello 文档".as_bytes())
      .expect("write stdin");
    let output = child.wait_with_output().expect("wait");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
      output.status.success(),
      "shim failed: {stdout} / {}",
      String::from_utf8_lossy(&output.stderr)
    );
    assert!(
      stdout.contains(r#"["-p","--tools","","a b"]"#),
      "unexpected argv: {stdout}"
    );
    assert!(stdout.contains("hello 文档"), "stdin not passed: {stdout}");

    let _ = std::fs::remove_dir_all(&dir);
  }

  /// 真实机器上验证：短名 "claude" 能解析到 PATH 里的 claude.exe/.cmd 并启动。
  /// 只跑 --version，不调用模型、不消耗额度。
  #[test]
  fn resolves_installed_claude_cli() {
    let installed = super::find_windows_on_path("claude").or_else(|| {
      super::windows_fallback_dirs()
        .into_iter()
        .flat_map(|dir| ["claude.exe", "claude.cmd"].map(move |name| dir.join(name)))
        .find(|path| path.is_file())
    });
    if installed.is_none() {
      eprintln!("claude CLI not installed, skipping");
      return;
    }

    let output = build_ai_cli_command("claude", &["--version".to_string()])
      .expect("build claude command")
      .stdin(Stdio::null())
      .output()
      .expect("run claude --version");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
      output.status.success() && stdout.to_ascii_lowercase().contains("claude"),
      "unexpected claude --version output: {stdout} / {}",
      String::from_utf8_lossy(&output.stderr)
    );
  }
}
