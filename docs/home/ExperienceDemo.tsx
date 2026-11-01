import {
  Check,
  CircleAlert,
  LoaderCircle,
  LogIn,
  Pencil,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import styles from './experience.module.css';

const LATENCY = 1200;

interface Row {
  fresh?: boolean;
  id: string;
  pending?: boolean;
  rolledBack?: boolean;
  title: string;
}

type Tone = 'busy' | 'error' | 'idle' | 'ok';

interface Pane {
  /** `ms: null` while the user is still waiting on the network. */
  metric?: { label: string; ms: number | null };
  rows: Row[] | null;
  status: { label: string; tone: Tone };
}

type Action = 'fail' | 'reload' | 'rename' | 'revisit';

type Kind = 'effect' | 'replica' | 'swr';

const KINDS: Kind[] = ['effect', 'swr', 'replica'];

interface Approach {
  /** Paints the previous value right away for a fetch action. */
  instantOn: Action[];
  /** Applies a write before the server answers. */
  optimistic: boolean;
  subtitle: string;
  syncLabel: string;
  title: string;
}

const APPROACHES: Record<Kind, Approach> = {
  effect: {
    instantOn: [],
    optimistic: false,
    subtitle: 'fetch on mount, state in the component',
    syncLabel: 'Loading…',
    title: 'useEffect',
  },
  replica: {
    instantOn: ['reload', 'revisit'],
    optimistic: true,
    subtitle: 'persisted replica, reconciled in the background',
    syncLabel: 'Syncing in background',
    title: 'local-replica',
  },
  swr: {
    instantOn: ['revisit'],
    optimistic: false,
    subtitle: 'in-memory cache, stale-while-revalidate',
    syncLabel: 'Revalidating',
    title: 'SWR',
  },
};

const INITIAL_ROWS: Row[] = [
  { id: 'roadmap', title: 'Q3 roadmap' },
  { id: 'sync', title: 'Sync engine notes' },
  { id: 'onboarding', title: 'Onboarding flow' },
];

const TEAMMATE_ROW: Row = { id: 'pricing', title: 'Pricing page review' };

const RENAMED = 'Q3 roadmap (final)';

const idlePanes = (): Record<Kind, Pane> => ({
  effect: { rows: INITIAL_ROWS, status: { label: 'Up to date', tone: 'idle' } },
  replica: { rows: INITIAL_ROWS, status: { label: 'Up to date', tone: 'idle' } },
  swr: { rows: INITIAL_ROWS, status: { label: 'Up to date', tone: 'idle' } },
});

const patch = (rows: Row[] | null, id: string, next: Partial<Row>) =>
  rows?.map((row) => (row.id === id ? { ...row, ...next } : row)) ?? null;

const clean = (rows: Row[]) => rows.map(({ id, title }) => ({ id, title }));

const StatusIcon = ({ tone }: { tone: Tone }) => {
  if (tone === 'busy') return <LoaderCircle className={styles.spin} size={14} />;
  if (tone === 'error') return <CircleAlert size={14} />;
  return <Check size={14} />;
};

function PaneView({ kind, pane }: { kind: Kind; pane: Pane }) {
  const approach = APPROACHES[kind];

  return (
    <div className={`${styles.pane} ${kind === 'replica' ? styles.paneReplica : ''}`}>
      <div className={styles.paneHeader}>
        <div className={styles.paneTitle}>{approach.title}</div>
        <div className={styles.status} data-tone={pane.status.tone}>
          <StatusIcon tone={pane.status.tone} />
          {pane.status.label}
        </div>
      </div>
      <div className={styles.paneSubtitle}>{approach.subtitle}</div>

      <div className={styles.window}>
        <div className={styles.windowBar}>
          <span />
          <span />
          <span />
          <div className={styles.windowTitle}>Topics</div>
        </div>
        <ul className={styles.list}>
          {pane.rows
            ? pane.rows.map((row) => (
                <li
                  className={styles.row}
                  data-fresh={row.fresh || undefined}
                  data-pending={row.pending || undefined}
                  data-rolled-back={row.rolledBack || undefined}
                  key={row.id}
                >
                  <span className={styles.rowDot} />
                  <span className={styles.rowTitle}>{row.title}</span>
                  {row.pending && <LoaderCircle className={styles.spin} size={12} />}
                  {row.fresh && <span className={styles.badge}>from server</span>}
                  {row.rolledBack && <span className={styles.badge}>rolled back</span>}
                </li>
              ))
            : INITIAL_ROWS.map((row) => (
                <li className={styles.row} key={row.id}>
                  <span className={styles.skeleton} />
                </li>
              ))}
        </ul>
      </div>

      <div className={styles.metric} data-instant={pane.metric?.ms === 0 || undefined}>
        {pane.metric ? (
          <>
            <span>{pane.metric.label}</span>
            <strong>
              {pane.metric.ms === null
                ? 'waiting…'
                : pane.metric.ms === 0
                  ? 'instant'
                  : `${pane.metric.ms / 1000} s`}
            </strong>
          </>
        ) : (
          <span>Pick an action above</span>
        )}
      </div>
    </div>
  );
}

export function ExperienceDemo() {
  const [panes, setPanes] = useState<Record<Kind, Pane>>(idlePanes);
  const [running, setRunning] = useState(false);
  const serverRows = useRef<Row[]>(INITIAL_ROWS);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const update = (fn: (pane: Pane, kind: Kind) => Pane) =>
    setPanes((current) => {
      const next = { ...current };
      for (const kind of KINDS) next[kind] = fn(current[kind], kind);
      return next;
    });

  const later = (fn: () => void) => {
    timers.current.push(
      setTimeout(() => {
        fn();
        setRunning(false);
      }, LATENCY),
    );
  };

  const fetchAgain = (action: 'reload' | 'revisit') => {
    const hasTeammateRow = serverRows.current.some((row) => row.id === TEAMMATE_ROW.id);
    if (!hasTeammateRow) serverRows.current = [...serverRows.current, TEAMMATE_ROW];
    const next = serverRows.current;
    const label = 'Content visible after';
    const isInstant = (kind: Kind) => APPROACHES[kind].instantOn.includes(action);

    update((pane, kind) =>
      isInstant(kind)
        ? {
            metric: { label, ms: 0 },
            rows: pane.rows && clean(pane.rows),
            status: { label: APPROACHES[kind].syncLabel, tone: 'busy' },
          }
        : {
            metric: { label, ms: null },
            rows: null,
            status: {
              label: kind === 'swr' ? 'Memory cache empty, loading…' : 'Loading…',
              tone: 'busy',
            },
          },
    );

    later(() =>
      update((pane, kind) =>
        isInstant(kind)
          ? {
              ...pane,
              rows: next.map((row) => ({
                ...row,
                fresh: !pane.rows?.some((shown) => shown.id === row.id),
              })),
              status: { label: 'Synced with server', tone: 'ok' },
            }
          : {
              metric: { label, ms: LATENCY },
              rows: clean(next),
              status: { label: 'Loaded', tone: 'ok' },
            },
      ),
    );
  };

  const write = (action: 'fail' | 'rename') => {
    const id = action === 'rename' ? 'roadmap' : 'sync';
    const original = serverRows.current.find((row) => row.id === id)?.title ?? '';
    const title =
      action === 'rename'
        ? original === RENAMED
          ? INITIAL_ROWS[0].title
          : RENAMED
        : `${original} v2`;
    const label = 'Feedback after';

    update((pane, kind) =>
      APPROACHES[kind].optimistic
        ? {
            metric: { label, ms: 0 },
            rows: patch(pane.rows && clean(pane.rows), id, { pending: true, title }),
            status: { label: 'Confirming with server', tone: 'busy' },
          }
        : {
            metric: { label, ms: null },
            rows: patch(pane.rows && clean(pane.rows), id, { pending: true }),
            status: { label: 'Saving…', tone: 'busy' },
          },
    );

    later(() => {
      if (action === 'rename') {
        serverRows.current = patch(serverRows.current, id, { title }) ?? serverRows.current;
      }
      update((pane, kind) => {
        if (APPROACHES[kind].optimistic) {
          return action === 'rename'
            ? {
                ...pane,
                rows: patch(pane.rows, id, { pending: false }),
                status: { label: 'Confirmed by server', tone: 'ok' },
              }
            : {
                ...pane,
                rows: patch(pane.rows, id, { pending: false, rolledBack: true, title: original }),
                status: { label: 'Rejected, rolled back', tone: 'error' },
              };
        }
        return action === 'rename'
          ? {
              metric: { label, ms: LATENCY },
              rows: patch(pane.rows, id, { pending: false, title }),
              status: { label: 'Saved', tone: 'ok' },
            }
          : {
              metric: { label, ms: LATENCY },
              rows: patch(pane.rows, id, { pending: false }),
              status: { label: 'Save failed', tone: 'error' },
            };
      });
    });
  };

  const run = (action: Action) => {
    setRunning(true);
    if (action === 'reload' || action === 'revisit') fetchAgain(action);
    else write(action);
  };

  return (
    <div className={styles.root}>
      <div className={styles.actions}>
        <button disabled={running} onClick={() => run('reload')} type="button">
          <RefreshCw size={14} />
          Reload the page
        </button>
        <button disabled={running} onClick={() => run('revisit')} type="button">
          <LogIn size={14} />
          Leave and come back
        </button>
        <button disabled={running} onClick={() => run('rename')} type="button">
          <Pencil size={14} />
          Rename a topic
        </button>
        <button disabled={running} onClick={() => run('fail')} type="button">
          <Undo2 size={14} />
          Rename, server rejects
        </button>
        <span className={styles.latency}>Simulated server latency: {LATENCY / 1000} s</span>
      </div>
      <div className={styles.panes}>
        {KINDS.map((kind) => (
          <PaneView key={kind} kind={kind} pane={panes[kind]} />
        ))}
      </div>
    </div>
  );
}
