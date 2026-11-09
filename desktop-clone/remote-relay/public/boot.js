(function () {
  var allowed=['ios-default','dark','tinted-light','clear-light','clear-dark'];
  try {
    var theme=localStorage.getItem('tinygpt-remote-theme'); if(theme==='light'||theme==='dark')document.documentElement.dataset.bootTheme=theme;
    var icon=new URL(location.href).searchParams.get('icon')||localStorage.getItem('tinygpt-mobile-icon');
    if(allowed.indexOf(icon)!==-1){document.querySelector('link[rel="apple-touch-icon"]').href='/icons/app-'+icon+'.png';document.querySelector('link[rel="manifest"]').href='/manifest.webmanifest?icon='+icon;}
  } catch (_) {}
  setTimeout(function(){var boot=document.getElementById('mobile-boot');if(boot&&!boot.dataset.ready){var label=document.getElementById('mobile-boot-label');label.textContent='Still opening TinyGPT…';label.hidden=false;document.getElementById('mobile-boot-retry').hidden=false;}},15000);
  document.addEventListener('click',function(event){if(event.target&&event.target.id==='mobile-boot-retry')location.reload();});
})();
