document.querySelectorAll('form[data-confirm]').forEach(form => {
  form.addEventListener('submit', event => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
});
document.querySelector('#refresh')?.addEventListener('click', () => location.reload());
document.querySelector('#copy-token')?.addEventListener('click', async () => {
  const input = document.querySelector('#new-token');
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText(input.value);
    status.textContent = 'Token copied.';
  } catch {
    input.select();
    status.textContent = 'Select and copy the token above.';
  }
});
// A one-time token must not remain visible when returning through browser history.
if (document.querySelector('#new-token')) {
  window.addEventListener('pagehide', () => { document.querySelector('#new-token').value = ''; });
  window.addEventListener('pageshow', event => { if (event.persisted) location.replace('/dashboard/tokens'); });
}
