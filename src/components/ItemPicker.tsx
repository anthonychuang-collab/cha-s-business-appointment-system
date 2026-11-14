"use client";
/**
 * 預約項目複選（表單用）：每個項目一個 checkbox，送出時為 FormData 的多個 itemIds。
 * 最多 MAX_ITEMS 項，達上限時其他選項暫時不能勾；伺服器仍會重新檢查。
 * disabled 時以 hidden input 送出原本的項目，避免被當成「清空」。
 */
import { useState } from "react";
import { MAX_ITEMS } from "@/lib/domain/rules";

export function ItemPicker(props: {
  items: { id: string; name: string }[];
  defaultSelected?: string[];
  disabled?: boolean;
  name?: string;
  legend?: string;
}) {
  const name = props.name ?? "itemIds";
  const [selected, setSelected] = useState<string[]>(props.defaultSelected ?? []);
  const toggle = (id: string, on: boolean) =>
    setSelected((cur) => (on ? (cur.includes(id) || cur.length >= MAX_ITEMS ? cur : [...cur, id]) : cur.filter((x) => x !== id)));

  return (
    <fieldset className="itempick" disabled={props.disabled}>
      <legend>
        {props.legend ?? "預約項目"}
        <small>可複選，最多 {MAX_ITEMS} 項{selected.length ? `・已選 ${selected.length} 項` : ""}</small>
      </legend>
      <div className="itempick-list">
        {props.items.map((i) => {
          const on = selected.includes(i.id);
          return (
            <label key={i.id} className={on ? "on" : ""}>
              <input
                type="checkbox" name={props.disabled ? undefined : name} value={i.id} checked={on}
                disabled={!on && selected.length >= MAX_ITEMS}
                onChange={(e) => toggle(i.id, e.target.checked)}
              />
              {i.name}
            </label>
          );
        })}
      </div>
      {props.disabled && selected.map((id) => <input key={id} type="hidden" name={name} value={id} />)}
    </fieldset>
  );
}
