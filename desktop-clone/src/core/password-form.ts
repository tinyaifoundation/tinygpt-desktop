/** Runs only inside the private sign-in view's isolated world. No field values
 * are read for discovery, and no credential is returned to an app renderer. */
export function preparePasswordForm(origin: string, token: string): boolean {
  const valid = (element: HTMLInputElement) => {
    const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
    return element.isConnected&&!element.disabled&&!element.readOnly&&rect.width>0&&rect.height>0&&style.visibility==='visible'&&style.display!=='none'&&style.opacity!=='0'&&document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===element;
  };
  if (window !== window.top || location.protocol !== 'https:' || location.origin !== origin) return false;
  const passwords = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(valid);
  if (passwords.length !== 1 || passwords[0].autocomplete.split(/\s+/).includes('new-password')) return false;
  const password = passwords[0], form = password.form;
  if (!form || form.target && !['_self','_top'].includes(form.target) || new URL(form.action || location.href).origin !== origin || form.method.toLowerCase() !== 'post') return false;
  const candidates = [...form.querySelectorAll<HTMLInputElement>('input')].filter(element=>valid(element)&&['text','email','tel'].includes(element.type));
  const named = candidates.filter(element=>['username','email'].includes(element.autocomplete));
  const username = named.length===1 ? named[0] : candidates.length===1 ? candidates[0] : null;
  if (candidates.length && !username) return false;
  (globalThis as any).__tinygptPasswordForm = {token,origin,url:location.href,document,password,username,form};
  return true;
}

export function fillPasswordForm(token: string, username: string, password: string): boolean {
  const binding = (globalThis as any).__tinygptPasswordForm;
  delete (globalThis as any).__tinygptPasswordForm;
  if (!binding || binding.token !== token) return false;
  const valid = () => window === window.top && document === binding.document && location.href === binding.url && location.origin === binding.origin && binding.form.isConnected && binding.form.method.toLowerCase() === 'post' && new URL(binding.form.action || location.href).origin === binding.origin && (!binding.form.target || ['_self','_top'].includes(binding.form.target)) && binding.password.type === 'password' && [binding.password,...(binding.username?[binding.username]:[])].every((element: HTMLInputElement)=>{
    const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
    return element.ownerDocument===document&&element.isConnected&&element.form===binding.form&&!element.disabled&&!element.readOnly&&rect.width>0&&rect.height>0&&style.visibility==='visible'&&style.opacity!=='0'&&document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===element;
  });
  if (!valid()) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  if (binding.username) {
    setter.call(binding.username,username);
    binding.username.dispatchEvent(new Event('input',{bubbles:true})); binding.username.dispatchEvent(new Event('change',{bubbles:true}));
  }
  // The site's input handler may have replaced the form after setting username.
  if (!valid()) return false;
  setter.call(binding.password,password);
  binding.password.dispatchEvent(new Event('input',{bubbles:true})); binding.password.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
}
