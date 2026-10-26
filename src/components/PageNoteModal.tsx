import { useEffect, useState } from 'react'
import type { PageAnnotation } from '../lib/pdf/types'
import { useI18n } from '../lib/i18n/I18nContext'
import { MarkdownMessage } from './MarkdownMessage'

type Props = {
  note: PageAnnotation | null
  onClose: () => void
  onSave: (id: string, body: string) => void
  onRemove: (id: string) => void
  onGotoPage: (pageIndex: number) => void
}

export function PageNoteModal({
  note,
  onClose,
  onSave,
  onRemove,
  onGotoPage,
}: Props) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!note) {
      setEditing(false)
      setDraft('')
      return
    }
    setDraft(note.body)
    setEditing(false)
  }, [note])

  if (!note) return null

  const commit = () => {
    const next = draft.trim()
    if (!next) return
    onSave(note.id, next)
    setEditing(false)
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal page-note-modal"
        role="dialog"
        aria-labelledby="page-note-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="page-note-modal-head">
          <div>
            <h2 id="page-note-title">{t('pageNote.title')}</h2>
            <p className="page-note-modal-meta">
              {t('pageNote.page', { page: note.pageIndex + 1 })}
            </p>
          </div>
          <div className="page-note-modal-actions">
            <button
              type="button"
              className="btn tiny"
              onClick={() => {
                onGotoPage(note.pageIndex)
              }}
            >
              {t('pageNote.goto')}
            </button>
            {!editing ? (
              <button
                type="button"
                className="btn tiny"
                onClick={() => setEditing(true)}
              >
                {t('pageNote.edit')}
              </button>
            ) : (
              <button
                type="button"
                className="btn tiny primary"
                onClick={commit}
                disabled={!draft.trim()}
              >
                {t('pageNote.save')}
              </button>
            )}
            <button
              type="button"
              className="btn tiny obs-btn-danger"
              onClick={() => {
                if (window.confirm(t('pageNote.confirmDelete'))) {
                  onRemove(note.id)
                  onClose()
                }
              }}
            >
              {t('pageNote.delete')}
            </button>
            <button type="button" className="btn tiny" onClick={onClose}>
              {t('pageNote.close')}
            </button>
          </div>
        </header>

        {editing ? (
          <textarea
            className="page-note-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={16}
            autoFocus
            placeholder={t('pageNote.placeholder')}
          />
        ) : (
          <div className="page-note-body">
            {note.body.trim() ? (
              <MarkdownMessage
                content={note.body}
                onGotoPage={(pageIndex) => {
                  onGotoPage(pageIndex)
                  onClose()
                }}
              />
            ) : (
              <p className="muted">{t('pageNote.empty')}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
