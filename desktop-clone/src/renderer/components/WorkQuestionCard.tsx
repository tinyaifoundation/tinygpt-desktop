import { useState } from 'react';
import type { DesktopBridge } from '../../shared/contracts';
import type { ChatUpdate } from '../../shared/chat';
import type { WorkQuestion } from '../../shared/work';
import { ApprovalCard } from './ApprovalCard';
import { Button } from './ui/button';
import { CircleHelp } from '../icons';

export function WorkQuestionCard({ question, bridge, update }: { question: WorkQuestion; bridge: Pick<DesktopBridge, 'answerWorkQuestion' | 'cancelWorkQuestion'>; update: (value: ChatUpdate) => void }) {
  const [option, setOption] = useState(''); const [text, setText] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (stop = false) => {
    if (busy || !stop && !option && !text.trim()) return;
    setBusy(true); setError('');
    try { const result = stop ? await bridge.cancelWorkQuestion(question.id) : await bridge.answerWorkQuestion({ questionId: question.id, ...(option ? { optionId: option } : { text: text.trim() }) }); if (!result.ok) throw Error(result.error); update(result.value); }
    catch (error) { setError(error instanceof Error ? error.message : 'Your answer could not be saved. Try again.'); }
    finally { setBusy(false); }
  };
  return <form className="work-question-card max-h-[70vh] overflow-y-auto" data-slot="work-question" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <ApprovalCard aria-label="Work question" descriptionId={`question-${question.id}`} heading="Your input is needed" icon={<CircleHelp />} title={question.question} description={<div className="work-question-content">
      {question.options.length > 0 && <div role="radiogroup" aria-label="Choose an answer" className="work-question-options">{question.options.map(choice => <label key={choice.id} className="work-question-choice" data-selected={option === choice.id}>
        <input type="radio" name={`answer-${question.id}`} value={choice.id} checked={option === choice.id} disabled={busy} onChange={() => { setOption(choice.id); setText(''); }} />
        <span className="work-question-choice-copy"><span>{choice.label}</span>{choice.description && <span className="work-question-choice-description">{choice.description}</span>}</span>
      </label>)}</div>}
      <input type="text" aria-label="Your answer" placeholder={question.options.length ? 'Or write your own answer…' : 'Write an answer…'} value={text} maxLength={4000} disabled={busy} onChange={event => { setText(event.currentTarget.value); setOption(''); }} className="work-question-input" />
      <p className="work-question-hint">Work continues after you answer.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>} actions={<><Button type="button" variant="ghost" disabled={busy} onClick={() => void submit(true)}>Stop task</Button><Button type="submit" disabled={busy || !option && !text.trim()}>{busy ? 'Saving…' : 'Submit answer'}</Button></>} />
  </form>;
}
