import { Check, CircleAlert, LoaderCircle, Pencil, RefreshCw, Undo2 } from 'lucide-react';
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

type Action = 'fail' | 'reload' | 'rename';

const INITIAL_ROWS: Row[] = [
  { id: 'roadmap', title: 'Q3 roadmap' },
  { id: 'sync', title: 'Sync engine notes' },
  { id: 'onboarding', title: 'Onboarding flow' },
];

const TEAMMATE_ROW: Row = { id: 'pricing', title: 'Pricing page review' };

const RENAMED = 'Q3 roadmap (final)';

const idlePane = (): Pane => ({
  rows: INITIAL_ROWS,
  status: { label: 'Up to date', tone: 'idle' },
});

const patch = (rows: Row[] | null, id: string, next: Partial<Row>) =>
  rows?.map((row) => (row.id === id ? { ...row, ...next } : row)) ?? null;

const clean = (rows: Row[]) => rows.map(({ id, title }) => ({ id, title }));

const StatusIcon = ({ tone }: { tone: Tone }) => {
  if (tone === 'busy') return <LoaderCircle className={styles.spin} size={14} />;
  if (tone === 'error') return <CircleAlert size={14} />;
  return <Check size={14} />;
};

function PaneView({ kind, pane }: { kind: 'replica' | 'server'; pane: Pane }) {
  const isReplica = kind === 'replica';

  return (
    <div className={`${styles.pane} ${isReplica ? styles.paneReplica : ''}`}>
      <div className={styles.paneHeader}>
        <div>
          <div className={styles.paneTitle}>{isReplica ? 'Local Replica' : 'Server-first'}</div>
          <div className={styles.paneSubtitle}>
            {isReplica ? 'SWR + Zustand + local-replica' : 'SWR + Zustand'}
          </div>
        </div>
        <div className={styles.status} data-tone={pane.status.tone}>
          <StatusIcon tone={pane.status.tone} />
          {pane.status.label}
        </div>
      </div>

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
  const [server, setServer] = useState<Pane>(idlePane);
  const [replica, setReplica] = useState<Pane>(idlePane);
  const [running, setRunning] = useState(false);
  const serverRows = useRef<Row[]>(INITIAL_ROWS);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const later = (fn: () => void) => {
    timers.current.push(
      setTimeout(() => {
        fn();
        setRunning(false);
      }, LATENCY),
    );
  };

  const run = (action: Action) => {
    setRunning(true);

    if (action === 'reload') {
      const hasTeammateRow = serverRows.current.some((row) => row.id === TEAMMATE_ROW.id);
      if (!hasTeammateRow) serverRows.current = [...serverRows.current, TEAMMATE_ROW];
      const next = serverRows.current;

      setServer({
        metric: { label: 'Content visible after', ms: null },
        rows: null,
        status: { label: 'Loading…', tone: 'busy' },
      });
      setReplica((pane) => ({
        metric: { label: 'Content visible after', ms: 0 },
        rows: pane.rows && clean(pane.rows),
        status: { label: 'Syncing in background', tone: 'busy' },
      }));
      later(() => {
        setServer({
          metric: { label: 'Content visible after', ms: LATENCY },
          rows: clean(next),
          status: { label: 'Loaded', tone: 'ok' },
        });
        setReplica((pane) => ({
          ...pane,
          rows: next.map((row) => ({
            ...row,
            fresh: !pane.rows?.some((shown) => shown.id === row.id),
          })),
          status: { label: 'Synced with server', tone: 'ok' },
        }));
      });
      return;
    }

    const id = action === 'rename' ? 'roadmap' : 'sync';
    const original = serverRows.current.find((row) => row.id === id)?.title ?? '';
    const title =
      action === 'rename'
        ? original === RENAMED
          ? INITIAL_ROWS[0].title
          : RENAMED
        : `${original} v2`;

    setServer((pane) => ({
      metric: { label: 'Feedback after', ms: null },
      rows: patch(pane.rows && clean(pane.rows), id, { pending: true }),
      status: { label: 'Saving…', tone: 'busy' },
    }));
    setReplica((pane) => ({
      metric: { label: 'Feedback after', ms: 0 },
      rows: patch(pane.rows && clean(pane.rows), id, { pending: true, title }),
      status: { label: 'Confirming with server', tone: 'busy' },
    }));

    later(() => {
      if (action === 'rename') {
        serverRows.current = patch(serverRows.current, id, { title }) ?? serverRows.current;
        setServer((pane) => ({
          metric: { label: 'Feedback after', ms: LATENCY },
          rows: patch(pane.rows, id, { pending: false, title }),
          status: { label: 'Saved', tone: 'ok' },
        }));
        setReplica((pane) => ({
          ...pane,
          rows: patch(pane.rows, id, { pending: false }),
          status: { label: 'Confirmed by server', tone: 'ok' },
        }));
      } else {
        setServer((pane) => ({
          metric: { label: 'Feedback after', ms: LATENCY },
          rows: patch(pane.rows, id, { pending: false }),
          status: { label: 'Save failed', tone: 'error' },
        }));
        setReplica((pane) => ({
          ...pane,
          rows: patch(pane.rows, id, { pending: false, rolledBack: true, title: original }),
          status: { label: 'Server rejected, rolled back', tone: 'error' },
        }));
      }
    });
  };

  return (
    <div className={styles.root}>
      <div className={styles.actions}>
        <button disabled={running} onClick={() => run('reload')} type="button">
          <RefreshCw size={14} />
          Reload the page
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
        <PaneView kind="server" pane={server} />
        <PaneView kind="replica" pane={replica} />
      </div>
    </div>
  );
}
