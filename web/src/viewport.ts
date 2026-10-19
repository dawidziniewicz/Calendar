// Okna (cena, rezerwacja) dopasowują się do widocznej części ekranu. Na iPhonie po otwarciu klawiatury
// przeglądarka zmniejsza tylko „widoczny” obszar (visualViewport) i przesuwa go — bez tego nagłówek okna
// z „Zapisz” uciekał nad ekran i nie dało się do niego wrócić.
const vv = window.visualViewport;

function update() {
  if (!vv) return;
  const root = document.documentElement.style;
  const keyboard = window.innerHeight - vv.height > 120; // wyraźnie mniejszy widoczny obszar = klawiatura
  root.setProperty('--vv-height', `${Math.round(vv.height)}px`);
  root.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
  if (keyboard) root.setProperty('--vv-gap', '6px');
  else root.removeProperty('--vv-gap');
}

if (vv) {
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
