import { Check, Minus, X } from 'lucide-react';
import { Fragment } from 'react';

import styles from './comparison.module.css';

type Tone = 'bad' | 'good' | 'mid';

interface Cell {
  text: string;
  tone: Tone;
}

interface Row {
  cells: [Cell, Cell, Cell];
  label: string;
}

const COLUMNS = [
  { name: 'Server-first', stack: 'SWR / React Query + store' },
  { name: 'Local Replica', stack: 'local-replica' },
  { name: 'Local-first', stack: 'Linear-style sync engine' },
];

const good = (text: string): Cell => ({ text, tone: 'good' });
const mid = (text: string): Cell => ({ text, tone: 'mid' });
const bad = (text: string): Cell => ({ text, tone: 'bad' });

const GROUPS: { rows: Row[]; title: string }[] = [
  {
    title: 'What users feel',
    rows: [
      {
        label: 'Open or reload a page',
        cells: [
          bad('Skeleton until the network answers'),
          good('Paints the replica on the first frame'),
          good('Paints from the local database'),
        ],
      },
      {
        label: 'Edit something',
        cells: [
          mid('Waits for the server, or hand-written optimism'),
          good('Instant, rolls back if the server rejects'),
          good('Instant, queued as a transaction'),
        ],
      },
      {
        label: 'Same item in several views',
        cells: [
          mid('Each cache patched by hand'),
          good('One patch reaches every replica'),
          good('One object graph'),
        ],
      },
      {
        label: 'Switch account or workspace',
        cells: [
          mid('Caches cleared by hand'),
          good('Partitioned by scope, stale responses dropped'),
          good('One database per workspace'),
        ],
      },
      {
        label: 'Offline edits, live multiplayer',
        cells: [bad('No'), bad('No, by design'), good('Yes')],
      },
    ],
  },
  {
    title: 'What it costs you',
    rows: [
      {
        label: 'Backend changes',
        cells: [
          good('None'),
          good('None, keeps your APIs'),
          bad('Sync protocol and sequencer'),
        ],
      },
      {
        label: 'Client database and migrations',
        cells: [good('None'), good('Versioned key-value rows'), bad('Yes')],
      },
      {
        label: 'Permissions',
        cells: [
          good('Your existing auth'),
          good('Your existing auth'),
          bad('Restated as sync rules'),
        ],
      },
      {
        label: 'Adoption',
        cells: [good('Already there'), good('One list at a time'), bad('The whole data layer')],
      },
    ],
  },
];

const ICONS = { bad: X, good: Check, mid: Minus };

function CellView({ cell }: { cell: Cell }) {
  const Icon = ICONS[cell.tone];

  return (
    <div className={styles.cellBody}>
      <span className={styles.icon} data-tone={cell.tone}>
        <Icon size={12} strokeWidth={3} />
      </span>
      <span>{cell.text}</span>
    </div>
  );
}

export function Comparison() {
  return (
    <div className={styles.scroller}>
      <div className={styles.grid} role="table">
        <div className={styles.corner} role="columnheader" />
        {COLUMNS.map((column, index) => (
          <div
            className={`${styles.head} ${index === 1 ? styles.highlight : ''}`}
            key={column.name}
            role="columnheader"
          >
            {index === 1 && <span className={styles.pill}>Sweet spot</span>}
            <div className={styles.headName}>{column.name}</div>
            <div className={styles.headStack}>{column.stack}</div>
          </div>
        ))}

        {GROUPS.map((group, groupIndex) => (
          <Fragment key={group.title}>
            <div className={styles.group} role="rowheader">
              {group.title}
            </div>
            <div className={styles.groupFill} />
            <div className={`${styles.groupFill} ${styles.highlight}`} />
            <div className={styles.groupFill} />
            {group.rows.map((row, rowIndex) => {
              const last =
                groupIndex === GROUPS.length - 1 && rowIndex === group.rows.length - 1;
              return (
                <Fragment key={row.label}>
                  <div className={styles.label} role="rowheader">
                    {row.label}
                  </div>
                  {row.cells.map((cell, index) => (
                    <div
                      className={`${styles.cell} ${index === 1 ? styles.highlight : ''}`}
                      data-last={(index === 1 && last) || undefined}
                      key={index}
                      role="cell"
                    >
                      <CellView cell={cell} />
                    </div>
                  ))}
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
