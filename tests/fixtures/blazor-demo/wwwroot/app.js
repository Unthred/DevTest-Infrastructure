let count = 0;
document.getElementById('inc').addEventListener('click', () => {
  count += 1;
  document.getElementById('status').textContent = `Clicked ${count}`;
});
