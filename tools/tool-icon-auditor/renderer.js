(() => {
  const $ = selector => document.querySelector(selector);
  let audit, icons, saved, selected, currentView = 'all', query = '', mode = 'complete', recordFile;
  let candidate = '', iconLimit = 16, saving = false, refreshing = false, toastTimer;
  const recorded = id => saved.replacements.find(r => r.tool === id);
  const applied = row => recorded(row.id)?.solarSlug === row.slug;
  const pending = () => saved.replacements.filter(choice => audit.rows.some(row => row.id === choice.tool && row.editable !== false && row.slug !== choice.solarSlug));
  const normalize = value => value.trim().toLowerCase().replace(/^@solar-icons\/react\/linear\//, '').replace(/^solar:/, '').replace(/-linear$/, '');
  function node(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; }
  function glyph(slug) {
    const e = node('span','glyph'); e.setAttribute('aria-hidden','true');
    if (icons[slug]) e.style.setProperty('--glyph', `url("data:image/svg+xml,${encodeURIComponent(icons[slug])}")`);
    return e;
  }
  function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
  function chain(row, slug = row.slug) {
    const line = node('div','chain-preview');
    if (row.editable === false) line.append(node('span','no-glyph','—'),node('span','', 'No toolchain row'));
    else line.append(glyph(slug),node('span','',row[mode]));
    return line;
  }
  function navButton(label, count, view) {
    const b = node('button','nav-item' + (currentView === view ? ' active' : ''));
    b.append(node('span','',label),node('span','nav-count',String(count))); b.setAttribute('aria-pressed',String(currentView === view));
    b.onclick = () => { currentView = view; renderNav(); renderTools(); };
    return b;
  }
  function renderNav() {
    $('#views').replaceChildren(navButton('All tools',audit.rows.length,'all'),navButton('New tools',(audit.newToolIds || []).length,'new'),navButton('Generic fallback',audit.rows.filter(r=>r.fallback).length,'fallback'),navButton('Pending changes',pending().length,'pending'),navButton('Recorded changes',saved.replacements.length,'recorded'));
    $('#groups').replaceChildren(...audit.groupOrder.map(group => navButton(group,audit.rows.filter(r=>r.group === group).length,group)));
    $('#copy-request').disabled = refreshing || !pending().length;
    const appliedCount = audit.rows.filter(row => applied(row)).length;
    $('#save-status').textContent = saved.replacements.length ? `${saved.replacements.length} replacement${saved.replacements.length === 1 ? '' : 's'} saved to disk · ${pending().length} pending · ${appliedCount} applied` : 'No changes recorded';
  }
  function filtered() {
    return audit.rows.filter(row => (currentView === 'all' || currentView === 'new' && (audit.newToolIds || []).includes(row.id) || currentView === 'pending' && recorded(row.id) && !applied(row) || currentView === 'recorded' && recorded(row.id) || currentView === 'fallback' && row.fallback || row.group === currentView) && (!query || [row.id,row.name,row.displayLabel,row.group,row.active,row.complete,row.slug,recorded(row.id)?.solarSlug || ''].join(' ').toLowerCase().includes(query)));
  }
  function renderTools() {
    const rows = filtered();
    $('#view-title').textContent = ({all:'All tools',new:'New tools',pending:'Pending changes',recorded:'Recorded changes',fallback:'Generic fallback'})[currentView] || currentView;
    $('#results-count').textContent = `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`;
    $('#empty').hidden = !!rows.length;
    $('#tools').replaceChildren(...rows.map(row => {
      const choice = recorded(row.id);
      const card = node('button','tool-card' + (selected?.id === row.id ? ' selected' : ''));
      card.dataset.toolId = row.id; card.setAttribute('aria-pressed',String(selected?.id === row.id));
      const top = node('div','card-heading'); const pad = node('span','icon-pad'); pad.append(row.editable === false ? node('span','no-glyph','—') : glyph(row.slug));
      const title = node('div'); title.append(node('div','card-name',row.name),node('div','card-group',row.group)); top.append(pad,title); if ((audit.newToolIds || []).includes(row.id)) top.append(node('span','tag new-tool','New')); card.append(top,chain(row));
      const bottom = node('div','card-bottom'); bottom.append(node('code','',row.editable === false ? 'No icon rendered' : row.slug));
      bottom.append(node('span','tag' + (choice ? ' recorded' : ''),choice ? applied(row) ? 'Applied' : 'Pending' : row.editable === false ? 'No row' : row.visibility.startsWith('Hidden') ? 'Hidden row' : row.fallback ? 'Fallback' : 'Mapped')); card.append(bottom);
      if (choice) { const next = node('div','card-replacement'); next.append(glyph(choice.solarSlug),node('span','', '→ ' + choice.solarSlug)); card.append(next); }
      card.onclick = () => { if (selected?.id === row.id) return; selected = row; candidate = choice?.solarSlug || ''; iconLimit = 16; renderTools(); renderInspector(); };
      return card;
    }));
  }
  function stage(label,slug) {
    const e = node('div','icon-stage'); e.append(node('div','stage-label',label));
    if (slug && icons[slug]) e.append(glyph(slug)); else { const dash = node('div','no-glyph','—'); dash.style.cssText = 'height:56px;padding-top:12px'; e.append(dash); }
    e.append(node('div','stage-slug',slug || 'No change selected')); return e;
  }
  function renderInspector() {
    const panel = $('#inspector-content'); panel.replaceChildren();
    if (!selected) { panel.append(node('p','empty-inspector','Choose a tool from the library to compare its current icon with a replacement.')); return; }
    const row = selected, choice = recorded(row.id);
    $('#inspector-tag').textContent = choice ? applied(row) ? 'Applied' : 'Pending' : row.editable === false ? 'No row' : row.fallback ? 'Generic fallback' : 'Mapped';
    $('#inspector-tag').className = 'tag' + (choice ? ' recorded' : '');
    panel.append(node('h2','inspector-title',row.name),node('p','inspector-group',row.group));
    if (row.editable !== false) {
      const stages = node('div','inspector-icons'); stages.id = 'stages'; panel.append(stages);
      const section = node('section','inspector-section');
      const label = node('label','field-label','Replacement Solar slug'); label.htmlFor = 'slug';
      const input = node('input','slug-field'); input.id = 'slug'; input.placeholder = 'e.g. file-text'; input.value = candidate; input.spellcheck = false; input.autocomplete = 'off'; input.maxLength = 160;
      const status = node('div','field-status'); status.id = 'slug-status'; status.setAttribute('aria-live','polite');
      const save = node('button','primary save-button',choice ? 'Update replacement' : 'Save replacement'); save.id = 'save-replacement'; save.onclick = saveReplacement;
      input.oninput = () => { candidate = input.value; iconLimit = 16; renderCandidate(); };
      input.onkeydown = event => { if (event.key === 'Enter' && !save.disabled) void saveReplacement(); };
      section.append(label,input,status,save);
      if (choice) { const undo = node('button','undo-button','Remove recorded replacement'); undo.onclick = () => removeReplacement(row.id); section.append(undo); }
      section.append(node('p','save-note','Saved directly to the change file. Your choices remain after closing the app.')); panel.append(section);
      const browser = node('section','inspector-section'); const heading = node('div','label-row'); heading.append(node('span','field-label','Browse Solar Linear'),node('span','',`${Object.keys(icons).length} icons`));
      const grid = node('div','icon-browser'); grid.id = 'icon-browser'; const more = node('button','more-icons','Show more icons'); more.id = 'more-icons'; more.onclick = () => { iconLimit += 24; renderCandidate(); };
      browser.append(heading,grid,more); panel.append(browser);
      const example = node('section','inspector-section inspector-example'); example.append(node('span','field-label','Toolchain preview')); const line = node('div'); line.id = 'candidate-chain'; example.append(line); panel.append(example);
    } else panel.append(node('p','empty-inspector inspector-section','This action does not render a toolchain icon, so there is no displayed icon to replace.'));
    const meta = node('div','metadata');
    for (const [label,value] of [['Shown in toolchain',row.visibility],['Text behavior',row.labelKind],['Availability',row.availability],['Icon mapping',row.editable === false ? 'None rendered' : `${row.semantic} → ${row.slug}`],['Tool identifier',row.id],['Source',row.source]]) { const line = node('div','meta-line'); line.append(node('strong','',label),document.createTextNode(value)); meta.append(line); }
    panel.append(meta);
    if (row.editable !== false) renderCandidate();
  }
  function renderCandidate() {
    const slug = normalize(candidate), valid = !!slug && Object.hasOwn(icons,slug);
    $('#stages').replaceChildren(stage('CURRENT',selected.slug),stage('REPLACEMENT',valid ? slug : ''));
    const status = $('#slug-status'); status.className = 'field-status' + (slug ? valid ? ' valid' : ' error' : '');
    status.textContent = !slug ? 'Paste a slug or choose an icon below.' : valid ? slug === selected.slug ? 'Already matches the current production icon.' : 'Valid Solar Linear icon · ' + slug : 'No exact slug found. Choose a match below.';
    $('#save-replacement').disabled = saving || refreshing || !valid || slug === selected.slug;
    $('#save-replacement').textContent = saving ? 'Saving…' : recorded(selected.id) ? 'Update replacement' : 'Save replacement';
    $('#candidate-chain').replaceChildren(chain(selected,valid ? slug : selected.slug));
    const matches = Object.keys(icons).filter(name => !slug || name.includes(slug)).sort((a,b) => (a === slug ? -1 : b === slug ? 1 : a.localeCompare(b)));
    $('#icon-browser').replaceChildren(...matches.slice(0,iconLimit).map(name => {
      const b = node('button','icon-option' + (name === slug ? ' chosen' : '')); b.setAttribute('aria-label',name); b.title = name; b.append(glyph(name),node('span','',name));
      b.onclick = () => { candidate = name; $('#slug').value = name; renderCandidate(); }; return b;
    }));
    $('#more-icons').hidden = matches.length <= iconLimit;
    if (!matches.length) $('#icon-browser').append(node('p','field-status','No matching icons.'));
  }
  async function saveReplacement() {
    if (saving || !selected) return;
    const slug = normalize(candidate), tool = selected.id;
    if (!Object.hasOwn(icons,slug)) return;
    saving = true; renderCandidate();
    try { saved = await window.auditApp.record({tool,solarSlug:slug}); renderNav(); renderTools(); if (selected?.id === tool) renderInspector(); toast('Saved to disk · ' + selected.name + ' → ' + slug); }
    catch (error) { toast('Could not save: ' + error.message); }
    finally { saving = false; if (selected?.editable !== false && $('#slug')) renderCandidate(); }
  }
  async function removeReplacement(tool) {
    try { saved = await window.auditApp.remove(tool); if (selected?.id === tool) candidate = ''; renderNav(); renderTools(); renderInspector(); toast('Recorded replacement removed.'); }
    catch (error) { toast('Could not remove: ' + error.message); }
  }
  async function load(refresh = false) {
    $('#retry').hidden = true;
    if (refresh && (refreshing || saving)) return;
    refreshing = true; $('#refresh-audit').disabled = true; $('#refresh-audit').textContent = 'Refreshing…';
    if (audit) { renderNav(); if ($('#slug')) renderCandidate(); }
    try {
      const previousId = selected?.id, draft = candidate;
      const data = await (refresh ? window.auditApp.refresh() : window.auditApp.load()); ({audit,icons,saved,recordFile} = data);
      selected = audit.rows.find(row => row.id === previousId) || audit.rows.find(row => row.name === 'search_web') || audit.rows[0]; candidate = previousId === selected.id ? draft : recorded(selected.id)?.solarSlug || '';
      $('#audit-summary').textContent = `${audit.stats.concrete} tools · ${audit.stats.dynamicFamilies} dynamic families · ${audit.stats.currentGlyphs} glyphs · Refreshed ${new Date(audit.generatedAt).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`;
      $('#solar-version').textContent = `Solar Linear ${audit.solarVersion} · ${Object.keys(icons).length} icons`;
      renderNav(); renderTools(); renderInspector(); $('#loading').hidden = true; $('#app').hidden = false;
      if (refresh) toast('Updated from current production source. Saved mappings were preserved.');
    } catch (error) { if (audit) toast('Could not refresh: ' + error.message); else { $('#loading-message').textContent = error.message; $('#retry').hidden = false; } }
    finally { refreshing = false; $('#refresh-audit').disabled = false; $('#refresh-audit').textContent = 'Refresh latest tools'; if (audit) { renderNav(); if ($('#slug')) renderCandidate(); } }
  }
  $('#search').oninput = event => { query = event.target.value.trim().toLowerCase(); renderTools(); };
  document.querySelectorAll('[data-mode]').forEach(button => { button.onclick = () => { mode = button.dataset.mode; document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.mode === mode))); renderTools(); renderInspector(); }; });
  $('#scope-toggle').onclick = () => { $('#scope-detail').hidden = !$('#scope-detail').hidden; $('#scope-toggle').setAttribute('aria-expanded',String(!$('#scope-detail').hidden)); };
  $('#copy-request').onclick = async () => { try { await window.auditApp.copyRequest(); toast('Update request copied. Paste it into your Codex chat to apply the saved choices.'); } catch (error) { toast(error.message); } };
  $('#show-file').onclick = async () => { try { await window.auditApp.showFile(); } catch (error) { toast(error.message); } };
  $('#refresh-audit').onclick = () => load(true);
  $('#retry').onclick = () => location.reload();
  window.addEventListener('keydown',event => { if ((event.ctrlKey || event.metaKey) && event.key === 'f') { event.preventDefault(); $('#search').focus(); $('#search').select(); } });
  void load();
})();
