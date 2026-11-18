import type { Hash } from "viem";
import { explorerTx } from "./lib/chain";

export type Receipt = { label: string; hash: Hash };

export function ReceiptList({ receipts }: { receipts: Receipt[] }) {
  return (
    <div className="list">
      <h3>Receipts</h3>
      {receipts.length === 0 ? <p className="lede">Each confirmed transaction lands here with its explorer link.</p> : null}
      {receipts.map((item) => {
        const url = explorerTx(item.hash);
        return (
          <article className="item" key={`${item.label}-${item.hash}`}>
            <div>{item.label}</div>
            <a href={url}>{url}</a>
          </article>
        );
      })}
    </div>
  );
}

export function StepProgress({ labels, active }: { labels: readonly string[]; active: number }) {
  return (
    <ol className="steps">
      {labels.map((label, index) => {
        const done = index < active;
        const current = index === active;
        return (
          <li key={label}>
            <span className={done ? "mark-step on" : current ? "mark-step now" : "mark-step"}>{done ? "✓" : index + 1}</span>
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
