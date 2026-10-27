import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AccountChooser, useAccountProvider } from './AccountChooser'
import { PopHead, Popover, PopSep } from './Popover'
import { Icon } from './Icon'
import { useChat } from '../store/chat'
import { useProject } from '../store/project'
import { CHAT, MODEL_PICKER, PROVIDER_NAME } from '../copy'
import { codexRecommendations, type ModelChoice } from '../../../shared/chat'

/** 회사 전환은 AccountChooser, 같은 회사의 모델 선택은 이 부품이 맡는다. */
export function ComposerModelChip({ placement = 'up' }: { placement?: 'up' | 'down' }) {
  const [open, setOpen] = useState(false)
  const [direction, setDirection] = useState(placement)
  const host = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const { provider, stateOf } = useAccountProvider()
  const state = stateOf(provider)
  const settings = useProject((s) => s.settings)
  const loadSettings = useProject((s) => s.loadSettings)
  const { models, modelChoice, modelProvider, modelLoading, modelSaving, modelsError, modelSaveError, loadModels, chooseModel } = useChat(useShallow((s) => ({
    models: s.models, modelChoice: s.modelChoice, modelProvider: s.modelProvider,
    modelLoading: s.modelLoading, modelSaving: s.modelSaving, modelsError: s.modelsError,
    modelSaveError: s.modelSaveError, loadModels: s.loadModels, chooseModel: s.chooseModel
  })))
  const sameProvider = modelProvider === provider
  const catalog = sameProvider ? models : null
  const choice = provider === 'codex' ? (sameProvider && catalog !== null ? modelChoice : settings?.chat_models?.[provider] ?? null) : null
  const selected = catalog?.find((m) => m.model === choice?.model)
  const recommendations = codexRecommendations(catalog ?? [])
  const loading = sameProvider && modelLoading
  const saving = sameProvider && modelSaving
  const listError = sameProvider ? modelsError : null
  const saveError = sameProvider ? modelSaveError : null
  const connection = state === 'connected' ? '연결됨' : state === 'need-login' ? '로그인 필요' : state === 'logging-in' ? '로그인 중' : state === 'no-tool' ? '설치 필요' : state === 'failed' || state === 'unknown' ? '확인 실패' : '확인 중'
  const depth = choice?.effort ? MODEL_PICKER.efforts[choice.effort] ?? choice.effort : MODEL_PICKER.defaultDepth
  const close = (): void => { setOpen(false); trigger.current?.focus() }

  useEffect(() => {
    if (open && provider === 'codex' && state === 'connected') void loadModels(provider)
  }, [open, provider, state, loadModels])

  useLayoutEffect(() => {
    if (!open) return
    const position = (): void => {
      const el = host.current
      if (!el) return
      const box = el.getBoundingClientRect()
      const above = box.top - 12
      const below = window.innerHeight - box.bottom - 12
      const next = placement === 'down' && below >= 560 ? 'down' : above > below ? 'up' : 'down'
      setDirection(next)
      el.style.setProperty('--model-pop-height', `${Math.max(120, next === 'up' ? above : below)}px`)
      const width = Math.min(400, window.innerWidth - 48)
      el.style.setProperty('--model-pop-shift', `${Math.min(0, window.innerWidth - 12 - box.left - width)}px`)
    }
    position()
    const first = host.current?.querySelector<HTMLButtonElement>('.model-option') ?? host.current?.querySelector<HTMLButtonElement>('.popover button')
    first?.focus()
    window.addEventListener('resize', position)
    return () => window.removeEventListener('resize', position)
  }, [open, placement])

  const pick = async (next: ModelChoice | null): Promise<void> => {
    if (await chooseModel(next, provider)) await loadSettings()
  }
  return (
    <div className="pop-host composer-model-host" ref={host}>
      <button type="button" className="model" ref={trigger} title={CHAT.modelChipTitle} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{PROVIDER_NAME[provider]} · {state === 'connected' && choice ? selected?.name ?? choice.model : connection} · {MODEL_PICKER.depthChip(depth)}</span><Icon name="chevronDown" size={12} />
      </button>
      <Popover open={open} onClose={close} align="left" placement={direction} label={CHAT.modelChipTitle}>
        <div className="pop-scroll model-picker">
          <PopHead>{MODEL_PICKER.companyTitle}</PopHead>
          <AccountChooser onPicked={close} />
          <PopSep />
          {provider === 'codex' ? <>
            <div className="model-picker-heading"><PopHead>{MODEL_PICKER.modelsTitle}</PopHead>
              {state === 'connected' && <button type="button" className="quiet" aria-label={MODEL_PICKER.reload} onClick={() => void loadModels(provider)} disabled={loading || saving}><Icon name="refresh" size={14} /></button>}
            </div>
            {state !== 'connected' ? <p className="model-picker-note">{MODEL_PICKER.connectFirst}</p> : <>
              <button type="button" className={`pop-row model-option${!choice ? ' cur' : ''}`} aria-pressed={!choice} disabled={saving} onClick={() => void pick(null)}>
                <span className="c"><b>{MODEL_PICKER.accountDefault}</b><small>{MODEL_PICKER.accountDefaultHint}</small></span>
                {!choice && <Icon name="check" size={16} />}
              </button>
              {loading && <p className="model-picker-note" role="status">{MODEL_PICKER.loading}</p>}
              {listError ? <div className="model-picker-note" role="alert"><p>{MODEL_PICKER.listFailed}</p><small>{listError}</small><button type="button" onClick={() => void loadModels(provider)} disabled={loading}>{CHAT.recheck}</button></div>
                : catalog?.map((m) => {
                  const recommended = recommendations.byModel[m.model]
                  return <button type="button" key={m.model} className={`pop-row model-option${choice?.model === m.model ? ' cur' : ''}`} aria-pressed={choice?.model === m.model} disabled={saving || loading} onClick={() => void pick({ model: m.model, effort: null })}>
                    <span className="c"><b>{m.name}</b><small>{recommended ? MODEL_PICKER.purpose(recommended.purpose) : m.description || MODEL_PICKER.otherModel}</small></span>
                    {recommended && <span className="model-recommend">{MODEL_PICKER.recommended}</span>}
                    {choice?.model === m.model && <Icon name="check" size={16} />}
                  </button>
                })}
              {!loading && !listError && catalog?.length === 0 && <p className="model-picker-note">{MODEL_PICKER.empty}</p>}
              <PopSep />
              <label className="model-depth"><span>{CHAT.depthTitle}</span>
                <select aria-label={CHAT.depthTitle} value={choice?.effort ?? ''} disabled={!selected || saving || loading || !!listError} onChange={(e) => { if (choice) void pick({ model: choice.model, effort: e.target.value || null }) }}>
                  <option value="">{MODEL_PICKER.defaultDepth}</option>
                  {selected?.efforts.map((e) => <option key={e} value={e}>{MODEL_PICKER.efforts[e] ?? e}</option>)}
                </select>
              </label>
              {!choice && <p className="model-picker-note">{MODEL_PICKER.chooseForDepth}</p>}
              {saving && <p className="model-picker-note" role="status">{MODEL_PICKER.saving}</p>}
              {saveError && <p className="model-picker-note" role="alert">{saveError}</p>}
              <p className="model-picker-note">{MODEL_PICKER.sameConversation}</p>
              {recommendations.lanes.some((l) => l.lane === 'review') && <p className="model-picker-note">{MODEL_PICKER.reviewNotice}</p>}
              {recommendations.tier === 'high' && <p className="model-picker-note">{MODEL_PICKER.limitNotice}</p>}
            </>}
          </> : <>
            <PopHead>{CHAT.depthTitle}</PopHead>
            <div className="pop-row off" aria-disabled="true"><span className="c"><b>{CHAT.depthDefault}</b><small>{CHAT.depthFollows(PROVIDER_NAME[provider])}</small></span></div>
          </>}
          <PopSep />
          <p className="model-picker-note">{MODEL_PICKER.subscription}</p>
        </div>
      </Popover>
    </div>
  )
}
