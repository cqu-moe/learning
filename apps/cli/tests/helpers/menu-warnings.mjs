process.stdin.once('data', () => {
  process.emitWarning('方向键操作期间的运行时警告', { code: 'MENU_RUNTIME' });
  console.warn('方向键操作期间的%s警告', '控制台');
});
