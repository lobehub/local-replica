import { Highlighter } from '@lobehub/ui';

import styles from './write.module.css';

const STEPS = [
  {
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
  },
  {
    code: `const useStore = create(() => ({
  topicsById: {}, // what components read
  topicsReplica: createReplicaState(), // bookkeeping
}));

const topicsSlice = createReplicaSlice(topics, {
  driver: createSWRDriver({ mutate, useSWR }),
  get: useStore.getState,
  set: useStore.setState,
  stateKey: 'topicsReplica',
  view: recordLens('topicsById'),
});`,
    description:
      'The replica writes into a field of your store, so the store stays the one place components read.',
    language: 'ts',
    title: 'Give it a slot in your store',
  },
  {
    code: `  function TopicList({ agentId }) {
-   const { data: topics } = useSWR(['topics', agentId], () => api.getTopics(agentId));
+   topicsSlice.useSync({ agentId });
+   const topics = useStore((s) => s.topicsById[agentId]);
    return <List items={topics} />;
  }`,
    description:
      'Paints from the replica on the first frame, then syncs. The rest of the component stays the same.',
    language: 'diff',
    title: 'Swap the hook',
  },
];

export function WriteSteps() {
  return (
    <ol className={styles.steps}>
      {STEPS.map((step, index) => (
        <li className={styles.step} key={step.title}>
          <div className={styles.text}>
            <span className={styles.number}>{index + 1}</span>
            <div className={styles.title}>{step.title}</div>
            <div className={styles.description}>{step.description}</div>
          </div>
          <Highlighter
            className={styles.code}
            language={step.language}
            style={{ fontSize: 13 }}
            variant={'filled'}
          >
            {step.code}
          </Highlighter>
        </li>
      ))}
    </ol>
  );
}
