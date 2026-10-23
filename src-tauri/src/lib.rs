use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::Manager;

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

fn run_python_ocr(app: &tauri::AppHandle, request: &OcrRequest) -> Result<serde_json::Value, String> {
  let script = resolve_ocr_script(app)?;
  let python = find_python();
  let payload = serde_json::to_string(request).map_err(|e| e.to_string())?;

  let output = Command::new(&python)
    .arg(&script)
    .arg("--stdin-json")
    .env("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    .env("PADDLE_PDX_MODEL_SOURCE", "bos")
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .spawn()
    .and_then(|mut child| {
      use std::io::Write;
      if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(payload.as_bytes())?;
      }
      child.wait_with_output()
    })
    .map_err(|e| format!("启动 Python OCR 失败: {e}"))?;

  if !output.status.success() {
    let err = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    return Err(format!("OCR 执行失败: {err}"));
  }

  let stdout = String::from_utf8_lossy(&output.stdout);
  extract_json_from_stdout(&stdout).map_err(|e| {
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    format!("解析 OCR 结果失败: {e}\nstdout: {stdout}\nstderr: {stderr}")
  })
}

#[tauri::command]
fn run_ocr(app: tauri::AppHandle, request: OcrRequest) -> Result<serde_json::Value, String> {
  run_python_ocr(&app, &request)
}

#[tauri::command]
fn detect_ocr_backends() -> serde_json::Value {
  let python = find_python();
  let paddle_ok = Command::new(&python)
    .args(["-c", "from paddleocr import PaddleOCR; print('ok')"])
    .output()
    .map(|o| o.status.success())
    .unwrap_or(false);

  serde_json::json!({
    "python": python,
    "offlineReady": paddle_ok,
    "onlineReady": true,
    "engine": if paddle_ok { "PP-OCRv6" } else { "none" }
  })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
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
    .invoke_handler(tauri::generate_handler![run_ocr, detect_ocr_backends])
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
