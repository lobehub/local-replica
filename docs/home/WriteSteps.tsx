import { Highlighter, Segmented } from '@lobehub/ui';
import { useState } from 'react';

import styles from './write.module.css';

type Stack = 'effect' | 'reactQuery' | 'swr' | 'swrStore';

interface Step {
  code: string;
  description: string;
  language: 'diff' | 'ts' | 'tsx';
  title: string;
}

const DESCRIBE: Step = {
  code: `const topics = defineReplica({
  name: 'topics',
  version: 1,
  key: ({ agentId }) => agentId,
  fetcher: ({ agentId }) => api.getTopics(agentId), // your existing API
  storage: (namespace) => new LocalStorageReplicaStorage({ namespace }),
});`,
  description: 'Name the data, point at the API you already call, and pick where the copy lives.',
  language: 'ts',
  title: 'Describe the data',
};

const CREATE_HOOK_BUILTIN: Step = {
  code: `export const { useReplica: useTopics } = createReplica(topics);`,
  description:
    'No store and no fetching library to add: a built-in driver dedupes requests and revalidates on focus and reconnect.',
  language: 'ts',
  title: 'Create the hook',
};

const CREATE_HOOK: Step = {
  code: `export const { useReplica: useTopics } = createReplica(topics, {
  driver: createSWRDriver({ mutate, useSWR }), // SWR schedules the requests
});`,
  description:
    'No store to add: the hook keeps the replica for you and returns the data, like useSWR.',
  language: 'ts',
  title: 'Create the hook',
};

const CREATE_HOOK_REACT_QUERY: Step = {
  code: `export const { useReplica: useTopics } = createReplica(topics, {
  driver: createReactQueryDriver({ queryClient, useQuery }), // your QueryClient
});`,
  description:
    'No store to add: the hook keeps the replica for you and returns the data, like useQuery.',
  language: 'ts',
  title: 'Create the hook',
};

const STACKS: Record<Stack, { label: string; steps: Step[]; today: string; todayNote: string }> = {
  effect: {
    label: 'useEffect',
    today: `function TopicList({ agentId }) {
  const [topics, setTopics] = useState();
  useEffect(() => {
    let cancelled = false;
    api.getTopics(agentId).then((data) => {
      if (!cancelled) setTopics(data);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  return <List items={topics} />;
}`,
    todayNote: 'Fetch on mount, state in the component.',
    steps: [
      DESCRIBE,
      CREATE_HOOK_BUILTIN,
      {
        code: `  function TopicList({ agentId }) {
-   const [topics, setTopics] = useState();
-   useEffect(() => {
-     let cancelled = false;
-     api.getTopics(agentId).then((data) => {
-       if (!cancelled) setTopics(data);
-     });
-     return () => {
-       cancelled = true;
-     };
-   }, [agentId]);
+   const { data: topics } = useTopics({ agentId });
    return <List items={topics} />;
  }`,
        description:
          'The effect, the local state and the race guard collapse into one hook. The list paints from the replica on the first frame, then syncs.',
        language: 'diff',
        title: 'Replace the effect',
      },
    ],
  },
  swr: {
    label: 'SWR',
    today: `function TopicList({ agentId }) {
  const { data: topics } = useSWR(['topics', agentId], () => api.getTopics(agentId));
  return <List items={topics} />;
}`,
    todayNote: 'In-memory cache: instant on revisit, empty after a reload.',
    steps: [
      DESCRIBE,
      CREATE_HOOK,
      {
        code: `  function TopicList({ agentId }) {
-   const { data: topics } = useSWR(['topics', agentId], () => api.getTopics(agentId));
+   const { data: topics } = useTopics({ agentId });
    return <List items={topics} />;
  }`,
        description:
          'Same shape as useSWR: data, error, isValidating. The difference is a copy that survives reloads.',
        language: 'diff',
        title: 'Swap the hook',
      },
    ],
  },
  reactQuery: {
    label: 'React Query',
    today: `function TopicList({ agentId }) {
  const { data: topics } = useQuery({
    queryKey: ['topics', agentId],
    queryFn: () => api.getTopics(agentId),
  });
  return <List items={topics} />;
}`,
    todayNote: 'In-memory cache: instant on revisit, empty after a reload.',
    steps: [
      DESCRIBE,
      CREATE_HOOK_REACT_QUERY,
      {
        code: `  function TopicList({ agentId }) {
-   const { data: topics } = useQuery({
-     queryKey: ['topics', agentId],
-     queryFn: () => api.getTopics(agentId),
-   });
+   const { data: topics } = useTopics({ agentId });
    return <List items={topics} />;
  }`,
        description:
          'The same QueryClient still schedules the requests. The difference is a copy that survives reloads.',
        language: 'diff',
        title: 'Swap the hook',
      },
    ],
  },
  swrStore: {
    label: 'SWR + store',
    today: `const useStore = create(() => ({ topicsById: {} }));

const useFetchTopics = (agentId) =>
  useSWR(['topics', agentId], () => api.getTopics(agentId), {
    onSuccess: (data) =>
      useStore.setState((s) => ({ topicsById: { ...s.topicsById, [agentId]: data } })),
  });

function TopicList({ agentId }) {
  useFetchTopics(agentId);
  const topics = useStore((s) => s.topicsById[agentId]);
  return <List items={topics} />;
}`,
    todayNote: 'SWR fetches, onSuccess copies the result into the store, components read the store.',
    steps: [
      DESCRIBE,
      {
        code: `  const useStore = create(() => ({
    topicsById: {},
+   topicsReplica: createReplicaState(),
  }));

+ const topicsSlice = createReplicaSlice(topics, {
+   driver: createSWRDriver({ mutate, useSWR }),
+   get: useStore.getState,
+   set: useStore.setState,
+   stateKey: 'topicsReplica',
+   view: recordLens('topicsById'), // the field you already read
+ });`,
        description:
          'One bookkeeping field next to the data you already keep. The replica writes into topicsById for you.',
        language: 'diff',
        title: 'Bind it to your store',
      },
      {
        code: `- const useFetchTopics = (agentId) =>
-   useSWR(['topics', agentId], () => api.getTopics(agentId), {
-     onSuccess: (data) =>
-       useStore.setState((s) => ({ topicsById: { ...s.topicsById, [agentId]: data } })),
-   });

  function TopicList({ agentId }) {
-   useFetchTopics(agentId);
+   topicsSlice.useSync({ agentId });
    const topics = useStore((s) => s.topicsById[agentId]);
    return <List items={topics} />;
  }`,
        description:
          'The hand-written onSuccess goes away. Selectors and components stay exactly as they are.',
        language: 'diff',
        title: 'Replace the fetch hook',
      },
    ],
  },
};

function StepRow({ code, description, index, language, title }: Step & { index?: number }) {
  return (
    <li className={styles.step}>
      <div className={styles.text}>
        {index === undefined ? (
          <span className={styles.today}>Today</span>
        ) : (
          <span className={styles.number}>{index}</span>
        )}
        <div className={styles.title}>{title}</div>
        <div className={styles.description}>{description}</div>
      </div>
      <Highlighter
        className={index === undefined ? `${styles.code} ${styles.todayCode}` : styles.code}
        language={language}
        style={{ fontSize: 13 }}
        variant={'filled'}
      >
        {code}
      </Highlighter>
    </li>
  );
}

export function WriteSteps() {
  const [stack, setStack] = useState<Stack>('swr');
  const current = STACKS[stack];

  return (
    <div className={styles.root}>
      <div className={styles.switcher}>
        <span className={styles.switcherLabel}>What do you use today?</span>
        <Segmented
          options={(Object.keys(STACKS) as Stack[]).map((value) => ({
            label: STACKS[value].label,
            value,
          }))}
          value={stack}
          onChange={(value) => setStack(value as Stack)}
        />
      </div>
      <ol className={styles.steps}>
        <StepRow
          code={current.today}
          description={current.todayNote}
          language="tsx"
          title={`With ${current.label}`}
        />
        {current.steps.map((step, index) => (
          <StepRow index={index + 1} key={`${stack}-${step.title}`} {...step} />
        ))}
      </ol>
    </div>
  );
}
