import { Check, Minus, X } from 'lucide-react';
import { Fragment } from 'react';

import styles from './comparison.module.css';

type Tone = 'bad' | 'good' | 'mid';

interface Cell {
  text: string;
  tone: Tone;
}

interface Row {
  cells: [Cell, Cell, Cell, Cell];
  label: string;
}

const COLUMNS = [
  { name: 'useEffect', stack: 'fetch on mount' },
  { name: 'SWR', stack: 'SWR / React Query' },
  { name: 'local-replica', stack: 'Local Replica' },
  { name: 'Sync engine', stack: 'Linear-style local-first' },
];

/** The highlighted column. */
const PICK = 2;

const good = (text: string): Cell => ({ text, tone: 'good' });
const mid = (text: string): Cell => ({ text, tone: 'mid' });
const bad = (text: string): Cell => ({ text, tone: 'bad' });

const GROUPS: { rows: Row[]; title: string }[] = [
  {
    title: 'What users feel',
    rows: [
      {
        label: 'Reload or reopen the app',
        cells: [
          bad('Skeleton until the network answers'),
          bad('Skeleton: the memory cache is gone'),
          good('Paints the replica on the first frame'),
          good('Paints from the local database'),
        ],
      },
      {
        label: 'Come back to a page',
        cells: [
          bad('Skeleton again, every visit'),
          good('Cached value, revalidated'),
          good('Replica, reconciled in the background'),
          good('Local database'),
        ],
      },
      {
        label: 'Edit something',
        cells: [
          bad('Waits for the server, then refetches'),
          mid('Waits, unless optimistic data is written by hand'),
          good('Instant, rolls back if the server rejects'),
          good('Instant, queued as a transaction'),
        ],
      },
      {
        label: 'Same item in several views',
        cells: [
          bad('Each component holds its own copy'),
          mid('Every cache key mutated by hand'),
          good('One patch reaches every replica'),
          good('One object graph'),
        ],
      },
      {
        label: 'Switch account or workspace',
        cells: [
          bad('Races between responses handled by hand'),
          mid('Cache keys and clearing handled by hand'),
          good('Partitioned by scope, stale responses dropped'),
          good('One database per workspace'),
        ],
      },
      {
        label: 'Offline edits, live multiplayer',
        cells: [bad('No'), bad('No'), bad('No, by design'), good('Yes')],
      },
    ],
  },
  {
    title: 'What it costs you',
    rows: [
      {
        label: 'Backend changes',
        cells: [good('None'), good('None'), good('None'), bad('Sync protocol and sequencer')],
      },
      {
        label: 'Client database and migrations',
        cells: [good('None'), good('None'), good('Versioned key-value rows'), bad('Yes')],
      },
      {
        label: 'Permissions',
        cells: [
          good('Your existing auth'),
          good('Your existing auth'),
          good('Your existing auth'),
          bad('Restated as sync rules'),
        ],
      },
      {
        label: 'Adoption',
        cells: [
          good('Already there'),
          good('One hook per query'),
          good('One list at a time'),
          bad('The whole data layer'),
        ],
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
            className={`${styles.head} ${index === PICK ? styles.highlight : ''}`}
            key={column.name}
            role="columnheader"
          >
            {index === PICK && <span className={styles.pill}>Sweet spot</span>}
            <div className={styles.headName}>{column.name}</div>
            <div className={styles.headStack}>{column.stack}</div>
          </div>
        ))}

        {GROUPS.map((group, groupIndex) => (
          <Fragment key={group.title}>
            <div className={styles.group} role="rowheader">
              {group.title}
            </div>
            {COLUMNS.map((column, index) => (
              <div
                className={`${styles.groupFill} ${index === PICK ? styles.highlight : ''}`}
                key={column.name}
              />
            ))}
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
                      className={`${styles.cell} ${index === PICK ? styles.highlight : ''}`}
                      data-last={(index === PICK && last) || undefined}
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
