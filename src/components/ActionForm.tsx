"use client";
import { startTransition, useActionState, useState, type FormEvent, type ReactNode } from "react";
import type { ActionState } from "@/app/admin/actions";

type Action = (p: ActionState, f: FormData) => Promise<ActionState>;

/**
 * React 19 的 <form action> 送出後會自動清空欄位；失敗時使用者得重填（違反規格 3.3）。
 * 改用 onSubmit 自行呼叫 action，保留欄位內容；按鈕的 name/value 透過 submitter 帶入。
 */
function submitWithoutReset(e: FormEvent<HTMLFormElement>, run: (f: FormData) => void) {
  e.preventDefault();
  const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
  const fd = new FormData(e.currentTarget, submitter);
  startTransition(() => run(fd));
}

function Message({ state }: { state: ActionState }) {
  if (!state) return null;
  return <p className={state.ok ? "alert info" : "alert"} role={state.ok ? "status" : "alert"}>{state.message}</p>;
}

/** 一般表單：送出後在下方顯示結果 */
export function ActionForm(props: { action: Action; children: ReactNode; submit?: string; className?: string; danger?: boolean; small?: boolean; confirm?: string }) {
  const [state, action, pending] = useActionState(props.action, null);
  return (
    <form className={props.className} onSubmit={(e) => {
      if (props.confirm && !window.confirm(props.confirm)) { e.preventDefault(); return; }
      submitWithoutReset(e, action);
    }}>
      {props.children}
      {props.submit && (
        <button className={`btn ${props.small !== false ? "small" : ""} ${props.danger ? "danger" : ""}`} disabled={pending}>
          {pending ? "處理中…" : props.submit}
        </button>
      )}
      <Message state={state} />
    </form>
  );
}

type Preview = { phase: "preview"; affected: { id: string; label: string; reasons: string[] }[] } | { phase: "saved" };

/**
 * 班表類異動：第一次送出只預覽受影響的預約，確認後才儲存（規格 5.5）。
 * 修改欄位後預覽會失效，必須重新預覽。
 */
export function PreviewForm(props: { action: Action; children: ReactNode; previewLabel?: string; className?: string }) {
  const [state, action, pending] = useActionState(props.action, null);
  const [dirty, setDirty] = useState(false);
  const data = state?.data as Preview | undefined;
  const previewing = state?.ok && data?.phase === "preview" && !dirty;
  return (
    <form className={props.className} onChange={() => setDirty(true)} onSubmit={(e) => { setDirty(false); submitWithoutReset(e, action); }}>
      {props.children}
      {!previewing && (
        <button className="btn small secondary" name="commit" value="0" disabled={pending}>{pending ? "計算中…" : props.previewLabel ?? "預覽影響"}</button>
      )}
      {state && !dirty && <Message state={state} />}
      {previewing && data.phase === "preview" && (
        <div className="note">
          {data.affected.length > 0 && (
            <ul style={{ margin: "0 0 12px", paddingLeft: 18 }}>
              {data.affected.map((a) => <li key={a.id}>{a.label}</li>)}
            </ul>
          )}
          <button className="btn small" name="commit" value="1" disabled={pending}>{pending ? "儲存中…" : "確認儲存"}</button>
        </div>
      )}
    </form>
  );
}
