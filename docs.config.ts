const github = 'https://github.com/lobehub/local-replica';

export default {
  atomDirs: [{ dir: 'src' }],
  title: 'local-replica',
  description:
    'A Linear-like, local-first feel, without rewriting your backend or adopting a sync engine.',
  siteUrl: 'https://local-replica.lobehub.com',
  homePage: './docs/home/home.tsx',
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
