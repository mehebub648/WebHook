(function(){
  function h(tag, attrs, children){
    const el = document.createElement(tag);
    if(attrs){ Object.entries(attrs).forEach(([k,v])=>{
      if(k==='class') el.className = v;
      else if(k==='for') el.htmlFor = v;
      else if(k.startsWith('on') && typeof v==='function'){ el.addEventListener(k.slice(2), v); }
      else el.setAttribute(k, v);
    }); }
    (children||[]).forEach(ch=>{
      if(typeof ch==='string') el.appendChild(document.createTextNode(ch));
      else if(ch) el.appendChild(ch);
    });
    return el;
  }

  function showToast(msg){
    try{
      const region = document.getElementById('toast_region') || document.body;
      const t = h('div', { class:'fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-4 py-2 rounded-lg shadow-lg z-50' }, [msg]);
      region.appendChild(t);
      setTimeout(()=> t.remove(), 1600);
    }catch(_){}
  }

  function buildUrl(base, opts){
    const segs = [];
    if(opts.resStatus && opts.resType){ segs.push(`res:${opts.resStatus}${opts.resType}`); }
    if(opts.forwardUrl){
      // Prefer bounded syntax to be safe
      segs.push(`fwd:$$${opts.forwardUrl}$$`);
    }
    if(opts.fullBody){ segs.push('fullbody:true'); }
    if(opts.tag){ segs.push(`tag:${encodeURIComponent(opts.tag)}`); }
    return base.replace(/\/$/, '') + (segs.length? '/' + segs.join('/') : '');
  }

  function template(){
    const wrapper = h('div', { id:'composer_root', class:'hidden' });

    const overlay = h('div', { id:'composer_overlay', class:'fixed inset-0 bg-slate-900/40 backdrop-blur-sm opacity-0 transition-opacity duration-200 hidden' });
    const panelWrap = h('div', { id:'composer_panel', class:'fixed inset-0 grid place-items-center hidden', role:'dialog', 'aria-modal':'true' });
    const inner = h('div', { id:'composer_inner', class:'w-full max-w-2xl mx-4 translate-y-4 opacity-0' });

    const card = h('div', { class:'rounded-2xl bg-white shadow-xl border border-slate-200 p-5' });

    const header = h('div', { class:'flex items-start gap-3' }, [
      h('div', { class:'size-10 rounded-xl bg-sky-100 text-sky-700 grid place-items-center' }, [ h('i',{ class:'fa-solid fa-wand-magic-sparkles'}) ]),
      h('div', { class:'flex-1' }, [
        h('h2', { class:'text-lg font-semibold' }, ['Configure URL']),
        h('p', { class:'text-sm text-slate-600 mt-1' }, ['Build parameters visually. This does not save anything.'])
      ]),
      h('button', { id:'composer_close', type:'button', class:'ml-auto text-slate-500 hover:text-slate-700 size-8 grid place-items-center rounded-md hover:bg-slate-100', title:'Close' }, [ h('i',{class:'fa-solid fa-xmark'}) ])
    ]);

    const form = h('form', { id:'composer_form', class:'mt-4 space-y-4' });

    // Base URL read-only
    const baseGroup = h('div', { class:'grid grid-cols-1 md:grid-cols-12 gap-3' }, [
      h('div', { class:'md:col-span-12' }, [
        h('label', { class:'text-xs font-medium text-slate-600 mb-1 block' }, ['Base URL']),
        h('div', { class:'flex items-center gap-2 bg-white border border-slate-300 rounded-lg px-3 py-2' }, [
          h('input', { id:'c_base', type:'text', class:'flex-1 bg-transparent text-sm font-mono text-slate-700', readonly:'', value:'' }),
          h('button', { type:'button', id:'c_copy_base', class:'text-slate-500 hover:text-slate-700 size-8 grid place-items-center rounded-md hover:bg-slate-100', title:'Copy base' }, [ h('i',{class:'fa-regular fa-copy'}) ])
        ])
      ])
    ]);

    // Response
    const resGroup = h('div', { class:'grid grid-cols-1 md:grid-cols-12 gap-3' }, [
      h('div', { class:'md:col-span-4' }, [
        h('label', { class:'text-xs font-medium text-slate-600 mb-1 block' }, ['Response Status']),
        h('select', { id:'c_res_status', class:'w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm' }, [
          ...["","200","201","202","204","301","302","400","401","403","404","409","422","429","500","502","503"].map(v=> h('option', { value:v }, [v? v : '—'] ))
        ])
      ]),
      h('div', { class:'md:col-span-4' }, [
        h('label', { class:'text-xs font-medium text-slate-600 mb-1 block' }, ['Response Type']),
        h('select', { id:'c_res_type', class:'w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm' }, [
          h('option', { value:'' }, ['—']),
          h('option', { value:'json' }, ['json']),
          h('option', { value:'html' }, ['html']),
          h('option', { value:'plain' }, ['plain'])
        ])
      ]),
      h('div', { class:'md:col-span-4 grid items-end' }, [
        h('div', { class:'text-[11px] text-slate-500' }, ['Use both fields to enable immediate mock response.'])
      ])
    ]);

    // Forwarding
    const fwdGroup = h('div', { class:'grid grid-cols-1 md:grid-cols-12 gap-3' }, [
      h('div', { class:'md:col-span-8' }, [
        h('label', { class:'text-xs font-medium text-slate-600 mb-1 block' }, ['Forward to URL (optional)']),
        h('input', { id:'c_fwd', type:'url', placeholder:'https://api.example.com/endpoint', class:'w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm' })
      ]),
      h('div', { class:'md:col-span-4' }, [
        h('label', { class:'text-xs font-medium text-slate-600 mb-1 block' }, ['Mode']),
        h('select', { id:'c_mode', class:'w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm' }, [
          h('option', { value:'sync' }, ['Synchronous (wait for response)']),
          h('option', { value:'bg' }, ['Background (respond immediately)'])
        ])
      ])
    ]);

    // Options
    const optsGroup = h('div', { class:'grid grid-cols-1 md:grid-cols-12 gap-3' }, [
      h('div', { class:'md:col-span-4' }, [
        h('label', { class:'text-xs font-medium text-slate-600 mb-1 block' }, ['Include Full Body']),
        h('div', { class:'flex items-center gap-2' }, [
          h('input', { id:'c_full', type:'checkbox', class:'size-4' }),
          h('span', { class:'text-sm text-slate-600' }, ['Use ', h('code',{class:'bg-slate-100 px-1 rounded font-mono'},['/fullbody:true']), ' to capture large upstream bodies'])
        ])
      ]),
      h('div', { class:'md:col-span-8' }, [
        h('label', { class:'text-xs font-medium text-slate-600 mb-1 block' }, ['Tag (optional)']),
        h('input', { id:'c_tag', type:'text', placeholder:'e.g. checkout', class:'w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm' })
      ])
    ]);

    // Preview
    const preview = h('div', { class:'grid grid-cols-1 md:grid-cols-12 gap-3' }, [
      h('div', { class:'md:col-span-12' }, [
        h('label', { class:'text-xs font-medium text-slate-600 mb-1 block' }, ['Preview']),
        h('div', { class:'flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-sm break-all' }, [
          h('span', { id:'c_preview' }, ['—'])
        ])
      ])
    ]);

    // Actions
    const actions = h('div', { class:'mt-4 flex items-center justify-end gap-2' }, [
      h('button', { type:'button', id:'c_copy', class:'px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 transition' }, ['Copy URL']),
      h('a', { id:'c_open', href:'#', target:'_blank', class:'inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition' }, [ h('i',{class:'fa-solid fa-arrow-up-right-from-square'}), 'Open URL' ])
    ]);

    form.append(baseGroup, resGroup, fwdGroup, optsGroup, preview, actions);
    card.append(header, form);
    inner.append(card);
    panelWrap.append(inner);
    wrapper.append(overlay, panelWrap);
    document.body.appendChild(wrapper);

    // Behavior
    function open(){
      overlay.classList.remove('hidden'); panelWrap.classList.remove('hidden');
      requestAnimationFrame(()=>{
        overlay.classList.add('opacity-100'); overlay.classList.remove('opacity-0');
        inner.classList.remove('translate-y-4','opacity-0');
      });
    }
    function close(){
      inner.classList.add('translate-y-4','opacity-0','transition','duration-150');
      overlay.classList.remove('opacity-100'); overlay.classList.add('opacity-0');
      setTimeout(()=>{ overlay.classList.add('hidden'); panelWrap.classList.add('hidden'); inner.classList.remove('transition','duration-150'); }, 150);
    }

    function sync(){
      const base = document.getElementById('c_base').value || '';
      const resStatus = document.getElementById('c_res_status').value;
      const resType = document.getElementById('c_res_type').value;
      const fwd = document.getElementById('c_fwd').value.trim();
      const mode = document.getElementById('c_mode').value;
      const full = document.getElementById('c_full').checked;
      const tag = document.getElementById('c_tag').value.trim();

      const opts = { resStatus: resStatus||'', resType: resType||'', forwardUrl: fwd||'', fullBody: full, tag: tag||'' };
      let url = buildUrl(base, opts);

      // Mode hint: For background forward, we must add a res param to reply immediately. If user picked bg without res, show hint.
      const needsResForBg = fwd && mode==='bg' && !(resStatus && resType);
      const previewEl = document.getElementById('c_preview');
      previewEl.textContent = url + (needsResForBg? '    ← add res:… for background forwarding' : '');

      const openA = document.getElementById('c_open');
      openA.href = url || '#';
    }

    // Wire
    ['c_res_status','c_res_type','c_fwd','c_mode','c_full','c_tag'].forEach(id=>{
      document.addEventListener('input', e=>{ if(e.target && e.target.id===id) sync(); });
      document.addEventListener('change', e=>{ if(e.target && e.target.id===id) sync(); });
    });
    document.getElementById('c_copy').addEventListener('click', ()=>{
      const text = document.getElementById('c_preview').textContent || '';
      const clean = text.replace(/\s+←.*/, '');
      navigator.clipboard.writeText(clean).then(()=> showToast('Copied URL'));
    });
    document.getElementById('c_copy_base').addEventListener('click', ()=>{
      const text = document.getElementById('c_base').value || '';
      navigator.clipboard.writeText(text).then(()=> showToast('Copied base URL'));
    });
    overlay.addEventListener('click', close);
    document.getElementById('composer_close').addEventListener('click', close);

    // Public API on window
    window.WebhookComposer = {
      open(baseUrl){
        document.getElementById('c_base').value = baseUrl || '';
        document.getElementById('c_res_status').value = '';
        document.getElementById('c_res_type').value = '';
        document.getElementById('c_fwd').value = '';
        document.getElementById('c_mode').value = 'sync';
        document.getElementById('c_full').checked = false;
        document.getElementById('c_tag').value = '';
        sync();
        open();
      }
    };
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', template);
  }else{ template(); }
})();
