/**
 * Files written to the buyer's repository: the project files plus what turns them into a
 * runnable repo (Expo scaffold for `app`, README / .gitignore). Project files always win.
 * Keep the Expo scaffold in sync with the web ZIP export (ai-marketplace builder/zip.ts).
 */

function slugify(name, fallback) {
  return (
    String(name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || fallback
  );
}

function expoScaffold(name) {
  const slug = slugify(name, 'my-app');
  return [
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: slug,
          version: '1.0.0',
          main: 'node_modules/expo/AppEntry.js',
          scripts: { start: 'expo start', android: 'expo start --android', ios: 'expo start --ios', web: 'expo start --web' },
          dependencies: {
            expo: '*',
            react: '*',
            'react-native': '*',
            'expo-status-bar': '*',
            'react-native-safe-area-context': '*',
          },
        },
        null,
        2
      )}\n`,
    },
    { path: 'app.json', content: `${JSON.stringify({ expo: { name, slug } }, null, 2)}\n` },
    {
      path: 'README.md',
      content: `# ${name}\n\nBuilt with AI Markets App Builder.\n\n\`\`\`bash\nnpm install\nnpx expo install --fix\nnpx expo start\n\`\`\`\n\nScan the QR code with Expo Go to run it on your phone.\n`,
    },
    { path: '.gitignore', content: 'node_modules/\n.expo/\ndist/\nweb-build/\n*.log\n.env\n.env.*\n.DS_Store\n' },
  ];
}

function webScaffold(name) {
  return [
    {
      path: 'README.md',
      content: `# ${name}\n\nBuilt with AI Markets App Builder — a static website (HTML/CSS/JS, no build step).\n\nOpen \`index.html\` in a browser, or publish it with GitHub Pages (Settings → Pages → Deploy from branch).\n`,
    },
    { path: '.gitignore', content: '.DS_Store\n*.log\n.env\n' },
  ];
}

/** @returns {{ path: string, content: string }[]} */
function exportFiles(project) {
  const own = (project.files || []).map((f) => ({ path: f.path, content: String(f.content ?? '') }));
  const have = new Set(own.map((f) => f.path));
  const extra = (project.kind === 'app' ? expoScaffold(project.name) : webScaffold(project.name)).filter((f) => !have.has(f.path));
  return [...own, ...extra];
}

module.exports = { exportFiles, expoScaffold, webScaffold, slugify };
