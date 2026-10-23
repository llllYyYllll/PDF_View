type Props = {
  open: boolean
  mode: 'offline' | 'online'
  apiUrl: string
  apiKey: string
  language: string
  onClose: () => void
  onSave: (next: {
    mode: 'offline' | 'online'
    apiUrl: string
    apiKey: string
    language: string
  }) => void
}

export function OcrSettingsModal({
  open,
  mode,
  apiUrl,
  apiKey,
  language,
  onClose,
  onSave,
}: Props) {
  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-labelledby="ocr-settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="ocr-settings-title">OCR 设置</h2>
        <p className="muted" style={{ margin: '0 0 8px', fontSize: '0.9rem' }}>
          离线 OCR 使用本机 PP-OCRv6（模型在 ~/.paddlex）。联网 OCR 需填写你自己的 HTTP 接口。
        </p>

        <label className="field">
          <span>模式</span>
          <select
            value={mode}
            onChange={(e) =>
              onSave({
                mode: e.target.value as 'offline' | 'online',
                apiUrl,
                apiKey,
                language,
              })
            }
          >
            <option value="offline">离线 OCR（PP-OCRv6）</option>
            <option value="online">联网 OCR（自定义 API）</option>
          </select>
        </label>

        <label className="field">
          <span>API 地址（联网模式必填）</span>
          <input
            type="url"
            placeholder="https://example.com/ocr"
            value={apiUrl}
            onChange={(e) =>
              onSave({ mode, apiUrl: e.target.value, apiKey, language })
            }
          />
        </label>

        <label className="field">
          <span>API Key（可选，Bearer）</span>
          <input
            type="password"
            placeholder="可选"
            value={apiKey}
            onChange={(e) =>
              onSave({ mode, apiUrl, apiKey: e.target.value, language })
            }
          />
        </label>

        <label className="field">
          <span>语言提示（传给服务端，离线忽略）</span>
          <input
            type="text"
            value={language}
            onChange={(e) =>
              onSave({ mode, apiUrl, apiKey, language: e.target.value })
            }
          />
        </label>

        <p className="status-line">
          联网协议：POST JSON {'{'} imageBase64 {'}'} → {'{'} text, words[] {'}'}
        </p>

        <div className="modal-actions">
          <button type="button" className="btn primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
