const github = 'https://github.com/lobehub/local-replica';

export default {
  atomDirs: [{ dir: 'src' }],
  title: 'local-replica',
  description:
    'A Linear-like, local-first feel, without rewriting your backend or adopting a sync engine.',
  siteUrl: 'https://local-replica.lobehub.com',
  publicDocs: [
    'docs/getting-started/introduction.mdx',
    'docs/getting-started/local-replica.mdx',
    'docs/getting-started/installation.mdx',
    'docs/getting-started/quick-start.mdx',
    'docs/guide/storage.mdx',
    'docs/guide/fetching.mdx',
    'docs/guide/invalidation.mdx',
    'docs/guide/bounding.mdx',
    'docs/guide/irregular-pages.mdx',
  ],
  themeConfig: {
    home: {
      hero: {
        title: 'local-replica',
        accent: 'Local-first feel, server-first architecture',
        actions: [
          { href: '/getting-started/introduction', label: 'Get Started' },
          { href: github, label: 'GitHub' },
        ],
      },
      features: [
        {
          title: 'Instant open',
          description:
            'The last confirmed value paints on the first frame. A reload never flashes a skeleton.',
          icon: 'Zap',
        },
        {
          title: 'Instant writes',
          description:
            'Optimistic overlays apply right away and roll back on failure. They never reach storage.',
          icon: 'Rocket',
        },
        {
          title: 'Consistent everywhere',
          description:
            'One entity patch or delete reaches every replica: list rows, detail caches, persisted rows.',
          icon: 'Blocks',
        },
        {
          title: 'Keep your stack',
          description:
            'Your APIs, your auth, SWR and Zustand stay as they are. No sync protocol, no client database.',
          icon: 'Code',
        },
        {
          title: 'Identity-safe',
          description:
            'Memory and storage are partitioned by user and workspace. Late responses from another scope are dropped.',
          icon: 'Shield',
        },
        {
          title: 'Deletes stay deleted',
          description:
            'Entity, key and resource invalidation purge every persisted variant, so nothing resurrects on reload.',
          icon: 'Sparkles',
        },
      ],
      install: 'npm i local-replica',
      ctaTitle: 'Add a replica to one list today',
      ctaFootnote: 'MIT licensed',
    },
    sidebarGroups: [
      { dir: 'docs/getting-started', icon: 'rocket', order: -2, title: 'Getting Started' },
      { dir: 'docs/guide', icon: 'book-open', order: -1, title: 'Guide' },
    ],
    navItems: [
      {
        external: true,
        href: 'https://www.npmjs.com/package/local-replica',
        icon: 'package',
        label: 'npm',
      },
    ],
    socialLinks: [{ href: github, icon: 'github', label: 'GitHub' }],
  },
};
