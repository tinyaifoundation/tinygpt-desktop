export function finishMobileBoot() {
  const boot = document.getElementById('mobile-boot'); if (!boot || boot.dataset.ready) return;
  boot.dataset.ready = 'true'; setTimeout(() => boot.remove(), 180);
}
