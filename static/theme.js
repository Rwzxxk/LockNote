'use strict';

(() => {
  const key = 'locknote.theme';
  const system = matchMedia('(prefers-color-scheme: dark)');
  const syntaxLight = document.querySelector('#syntax-light');
  const syntaxDark = document.querySelector('#syntax-dark');
  let preference = 'system';
  try {
    const saved = localStorage.getItem(key);
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch {
    // A preferência continua disponível durante a sessão.
  }

  function applyTheme() {
    const dark = preference === 'dark' || (preference === 'system' && system.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    syntaxLight.media = dark ? 'not all' : 'all';
    syntaxDark.media = dark ? 'all' : 'not all';
  }

  applyTheme();
  system.addEventListener('change', applyTheme);
  document.addEventListener('DOMContentLoaded', () => {
    const choice = document.querySelector('#theme-choice');
    choice.value = preference;
    choice.addEventListener('change', () => {
      preference = choice.value;
      applyTheme();
      try {
        localStorage.setItem(key, preference);
      } catch {
        // O tema escolhido permanece ativo nesta página.
      }
    });
  });
})();
