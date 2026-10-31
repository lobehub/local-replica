import { Highlighter } from '@lobehub/ui';
import {
  AgentSkillCard,
  FeatureGrid,
  type FeatureGridItem,
  InstallBanner,
  LandingHero,
  LandingSection,
} from '@lobehub/ui/awesome';
import { GithubIcon } from '@lobehub/ui/icons';
import { ArrowRight, Blocks, Database, Layers, Rocket, Shield, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router';

import { Comparison } from './Comparison';
import { ExperienceDemo } from './ExperienceDemo';
import { renderLink } from './renderLink';

const SITE_URL = 'https://local-replica.lobehub.com';
const GITHUB_URL = 'https://github.com/lobehub/local-replica';
const INSTALL_COMMAND = 'npm i local-replica';

const FEATURES: FeatureGridItem[] = [
  {
    description:
      'The head page from the network replaces the replica. Loaded pages, client-only rows and pending writes survive.',
    href: '/getting-started/local-replica',
    icon: Rocket,
    title: 'Server confirms quietly',
  },
  {
    description:
      'A failed write rolls back to the confirmed base plus the writes still in flight. Optimistic values never reach storage.',
    href: '/getting-started/quick-start',
    icon: Layers,
    title: 'Optimistic, never persisted',
  },
  {
    description:
      'linkReplicaEntity sends a patch or delete to every replica that holds the entity, loaded or only persisted.',
    href: '/getting-started/local-replica',
    icon: Blocks,
    title: 'One entity, every copy',
  },
  {
    description:
      'Entity, key and resource invalidation purge every persisted variant and block hydrates already in flight.',
    href: '/guide/invalidation',
    icon: Trash2,
    title: 'Deletes stay deleted',
  },
  {
    description:
      'Memory and storage are partitioned by user and workspace. Late responses from a previous scope are dropped.',
    href: '/getting-started/local-replica',
    icon: Shield,
    title: 'Identity-safe',
  },
  {
    description:
      'IndexedDB, SQLite over IPC or localStorage, with an opt-in per-scope cap and least-recently-used eviction.',
    href: '/guide/storage',
    icon: Database,
    title: 'Any storage, bounded',
  },
];

const CODE = `const topicList = definePagedReplica({
  key: ({ agentId }) => \`agent_\${agentId}\`,
  name: 'topicList',
  paging: { direction: 'forward', getId: (t) => t.id, mode: 'offset' },
  scope,
  storage: (namespace) => new KeyValueReplicaStorage({ namespace, store }),
  version: 1,
});

const slice = createReplicaSlice(topicList, {
  driver: createSWRDriver({ mutate, useSWR }),
  fetcher: fetchTopicPage, // your existing API, unchanged
  get,
  set,
  stateKey: 'topicListReplica',
  view: recordLens('topicDataMap'), // components keep their selectors
});

// in a component: paint from the replica, then sync
slice.useSync({ agentId });`;

export default function Home({
  description,
  getStartedPathname,
}: {
  description: string;
  getStartedPathname: string;
}) {
  const navigate = useNavigate();

  return (
    <>
      <LandingHero
        accent="Local-first feel, server-first architecture"
        description={<span data-pagefind-meta="description">{description}</span>}
        renderLink={renderLink}
        title={<span data-pagefind-meta="title">local-replica</span>}
        actions={[
          {
            href: getStartedPathname,
            icon: ArrowRight,
            iconPlacement: 'end',
            label: 'Get Started',
            primary: true,
          },
          { href: GITHUB_URL, icon: GithubIcon, label: 'GitHub' },
        ]}
        aside={
          <AgentSkillCard
            agent={{
              code: `Read ${SITE_URL}/skills.md and use local-replica to make one list in this app paint instantly.`,
              description: 'Send this prompt to your agent to adopt local-replica',
            }}
            footer={
              <>
                <a href="/skills.md" rel="noreferrer" target="_blank">
                  skills.md
                </a>
                <a href="/llms.txt" rel="noreferrer" target="_blank">
                  llms.txt
                </a>
              </>
            }
            human={{
              code: INSTALL_COMMAND,
              description: 'Install the package',
            }}
          />
        }
        onNavigate={navigate}
      />

      <LandingSection
        description="Three common ways to load server data, all calling the same simulated server. Run an action and compare what the user sees and how long they wait."
        eyebrow="Try it"
        eyebrowColor="blue"
        id="home-experience"
        renderLink={renderLink}
        title="Same app, three approaches"
        onNavigate={navigate}
      >
        <ExperienceDemo />
      </LandingSection>

      <LandingSection
        description="The common approaches side by side. Local Replica gives users what a sync engine gives them, at the cost of a server-first app."
        eyebrow="Compare"
        eyebrowColor="purple"
        id="home-comparison"
        renderLink={renderLink}
        title="Local-first experience, server-first cost"
        actions={[
          {
            href: '/getting-started/local-replica',
            icon: ArrowRight,
            iconPlacement: 'end',
            label: 'The Local Replica approach',
          },
        ]}
        onNavigate={navigate}
      >
        <Comparison />
      </LandingSection>

      <LandingSection
        description="Once a replica is persisted it outlives the session, the user and the write in flight. These problems are handled for you."
        eyebrow="Under the hood"
        eyebrowColor="orange"
        id="home-features"
        renderLink={renderLink}
        title="What you don't have to think about"
        onNavigate={navigate}
      >
        <FeatureGrid items={FEATURES} renderLink={renderLink} />
      </LandingSection>

      <LandingSection
        description="A resource definition, a fetcher and a useSync call. Your APIs and your fetch layer stay as they are."
        eyebrow="Code"
        eyebrowColor="green"
        id="home-code"
        renderLink={renderLink}
        title="What you write"
        actions={[
          {
            href: '/getting-started/quick-start',
            icon: ArrowRight,
            iconPlacement: 'end',
            label: 'Quick Start',
          },
        ]}
        onNavigate={navigate}
      >
        <Highlighter language={'ts'} style={{ fontSize: 13, width: '100%' }} variant={'filled'}>
          {CODE}
        </Highlighter>
      </LandingSection>

      <InstallBanner
        command={INSTALL_COMMAND}
        title="Add a replica to one list today"
        footnote={
          <>
            Open source · MIT license · <Link to={getStartedPathname}>Get Started →</Link>
          </>
        }
      />
    </>
  );
}
