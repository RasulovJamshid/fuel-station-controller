import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AtgConfigSnapshot, AtgBranchInfo, AtgSlotInfo } from '../../types/api';
import { useAppStore } from '../../store';
import { addScannedTanks, type AtgScanDevice, type AtgTankSelection } from '../../lib/atgDiscovery';
import { AtgDiscoveryResults } from './AtgDiscoveryResults';

const input = 'rounded border border-border-primary bg-bg-primary px-2 py-1 text-sm w-full';
export function AtgSetup({ config, token, onSaved }: {config: AtgConfigSnapshot; token: string; onSaved: () => Promise<void>}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(config);
  const [auth, setAuth] = useState<Record<string,string> | null | undefined>();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [message,setMessage] = useState('');
  const [subnet,setSubnet] = useState('');
  const [found,setFound] = useState<{profile:AtgBranchInfo;devices:AtgScanDevice[]} | null>(null);
  const site = useAppStore(s => s.siteSnapshot);
  const products = site?.products ?? [];
  const positions = site?.positions ?? [];
  useEffect(() => {setDraft(config); setAuth(undefined); setFound(null);},[config]);
  const field = (label: string, value: string | number, change: (v: string) => void, type='text') => <label className="text-xs text-text-secondary flex flex-col gap-1">{label}<input className={input} type={type} value={value} onChange={e=>change(e.target.value)} /></label>;
  const changeBranch = (i: number, patch: Partial<AtgBranchInfo>) => {
    if (['host','port','unit_id','start_register','address_base','register_count','word_order','height_unit'].some(key => key in patch)) setFound(null);
    setDraft(d=>({...d,branches:d.branches.map((b,j)=>i===j?{...b,...patch}:b)}));
  };
  const changeSlot = (i: number,j: number, patch: Partial<AtgSlotInfo>) => changeBranch(i,{slots:draft.branches[i].slots.map((s,k)=>j===k?{...s,...patch}:s)});
  const save = async () => {
    setBusy(true);setError('');setMessage('');
    try {
      const {invoke}=await import('@tauri-apps/api/core');
      const {auth: _masked, ...body}=draft;
      const branches = body.branches.map(branch => ({
        ...branch,
        slots: branch.slots.map(slot => {
          const tank = body.tanks.find(t => t.tank_id === slot.tank_id);
          if (!tank) return slot;
          const maxima = { ...slot.maxima };
          delete maxima.product_volume;
          return { ...slot, product_id: tank.product_id, capacity_l: undefined, maxima };
        }),
      }));
      await invoke('admin_save_atg_config', { token, body: { ...body, branches, ...(auth !== undefined ? { auth } : {}) } });
      await onSaved();setMessage('ATG settings saved.');
    } catch(e) {setError(String(e));} finally {setBusy(false);}
  };
  const probe = async (branch: AtgBranchInfo, network = false) => {
    setBusy(true);setError('');setMessage('');setFound(null);
    try {
      const {invoke}=await import('@tauri-apps/api/core');
      const result=await invoke<{devices:AtgScanDevice[]}>('admin_atg_discover',{token,query:{...(!network?{host:branch.host}:subnet?{subnet}:{}),branch_id:branch.id,port:branch.port,unit_id:branch.unit_id,start_register:branch.start_register,address_base:branch.address_base,register_count:branch.register_count,word_order:branch.word_order,height_unit:branch.height_unit}});
      setFound({profile:{...branch},devices:result.devices});
    } catch(e) {setError(String(e));} finally {setBusy(false);}
  };
  const addSelected = (selections: AtgTankSelection[]) => {
    if (!found) return;
    try {
      setDraft(addScannedTanks(draft, found.profile, selections, products));
      setFound(null);setError('');setMessage(t('admin.atg.scan.added'));
    } catch (e) {setError(t(`admin.atg.scan.${e instanceof Error ? e.message : 'invalidSelection'}`));}
  };
  return <section id="admin-atg" className="rounded-2xl border border-border-primary p-6 space-y-4">
    <fieldset disabled={busy} className="min-w-0 space-y-4">
    <h2 className="text-lg font-bold">ATG and physical tanks</h2>
    <label className="flex gap-2"><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>Enable ATG polling</label>
    <div className="grid grid-cols-3 gap-3">
      {field('Poll interval (seconds)',draft.poll_interval_secs,v=>setDraft({...draft,poll_interval_secs:Number(v)}),'number')}
      {field('Response timeout (seconds)',draft.modbus_timeout_secs,v=>setDraft({...draft,modbus_timeout_secs:Number(v)}),'number')}
      {field('Stale after (seconds; blank = twice poll interval)',draft.stale_after_secs??'',v=>setDraft({...draft,stale_after_secs:v?Number(v):null}),'number')}
    </div>
    <h3 className="font-semibold">Tanks</h3>
    {draft.tanks.map((tank,i)=><div key={tank.tank_id} className="rounded border border-border-primary p-3 space-y-2">
      <p className="text-xs text-text-muted">Tank ID: {tank.tank_id}</p>
      <div className="grid grid-cols-4 gap-2">
        {field('Label',tank.label,v=>setDraft({...draft,tanks:draft.tanks.map((t,j)=>j===i?{...t,label:v}:t)}))}
        <label className="text-xs">Product<select className={input} value={tank.product_id} onChange={e=>setDraft({...draft,tanks:draft.tanks.map((t,j)=>j===i?{...t,product_id:Number(e.target.value),nozzle_sources:[]}:t)})}>{products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {field('Capacity (L)',tank.capacity_l,v=>setDraft({...draft,tanks:draft.tanks.map((t,j)=>j===i?{...t,capacity_l:Number(v)}:t)}),'number')}
        {field('Starting volume (L)',tank.current_l,v=>setDraft({...draft,tanks:draft.tanks.map((t,j)=>j===i?{...t,current_l:Number(v)}:t)}),'number')}
      </div>
      <details><summary className="text-xs">Nozzles supplied by this tank (for per-tank accounting)</summary><div className="flex flex-wrap gap-3 mt-2">{positions.flatMap(fp=>fp.nozzles.filter(n=>n.product_id===tank.product_id).map(n=> {
        const selected=tank.nozzle_sources?.some(s=>s.fp_id===fp.fp_id&&s.nozzle_index===n.index)??false;
        return <label className="text-xs" key={`${fp.fp_id}/${n.index}`}><input type="checkbox" checked={selected} onChange={e=>setDraft({...draft,tanks:draft.tanks.map((t,j)=>j!==i?t:{...t,nozzle_sources:e.target.checked?[...(t.nozzle_sources??[]),{fp_id:fp.fp_id,nozzle_index:n.index}]:(t.nozzle_sources??[]).filter(s=>s.fp_id!==fp.fp_id||s.nozzle_index!==n.index)})})}/>{fp.label} / {n.index}</label>;
      }))}</div></details>
      <button type="button" onClick={()=>setDraft({...draft,tanks:draft.tanks.filter((_,j)=>j!==i)})}>Remove tank</button>
    </div>)}
    <button type="button" disabled={!products.length} onClick={()=>setDraft({...draft,tanks:[...draft.tanks,{tank_id:crypto.randomUUID(),product_id:products[0].id,label:`Tank ${draft.tanks.length+1}`,capacity_l:25000,current_l:0}]})}>Add tank</button>
    <h3 className="font-semibold">Controllers</h3>
    {field('Discovery subnet (optional, e.g. 192.168.1)',subnet,setSubnet)}
    {found && <AtgDiscoveryResults config={draft} profile={found.profile} devices={found.devices} products={products} onAdd={addSelected} onClose={()=>setFound(null)} />}
    {draft.branches.map((b,i)=><div key={b.id} className="rounded border border-border-primary p-3 space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {field('Controller name',b.name,v=>changeBranch(i,{name:v}))}
        {field('Host / IP',b.host,v=>changeBranch(i,{host:v}))}
        {field('TCP port',b.port,v=>changeBranch(i,{port:Number(v)}),'number')}
        {field('External station ID',b.external_station_id??b.id,v=>changeBranch(i,{external_station_id:v?Number(v):null}),'number')}
        {field('Unit ID',b.unit_id,v=>changeBranch(i,{unit_id:Number(v)}),'number')}
        {field('Start register',b.start_register,v=>changeBranch(i,{start_register:Number(v)}),'number')}
        {field('Address base (0 or 1)',b.address_base,v=>changeBranch(i,{address_base:Number(v)}),'number')}
        {field('Registers (12 per slot)',b.register_count,v=>changeBranch(i,{register_count:Number(v)}),'number')}
        <label className="text-xs">Float order<select className={input} value={b.word_order??'ABCD'} onChange={e=>changeBranch(i,{word_order:e.target.value as AtgBranchInfo['word_order']})}>{['ABCD','CDAB','BADC','DCBA'].map(o=><option key={o}>{o}</option>)}</select></label>
        <label className="text-xs">Height unit<select className={input} value={b.height_unit??'mm'} onChange={e=>changeBranch(i,{height_unit:e.target.value as 'mm'|'m'})}><option value="mm">Millimetres</option><option value="m">Metres</option></select></label>
      </div>
      {b.slots.map((s,j)=><div className="grid grid-cols-4 gap-2 items-end" key={j}>
        {field('Slot',s.slot,v=>changeSlot(i,j,{slot:Number(v)}),'number')}
        <label className="text-xs">Physical tank<select className={input} value={s.tank_id??''} onChange={e=>{const t=draft.tanks.find(t=>t.tank_id===e.target.value);if(t)changeSlot(i,j,{tank_id:t.tank_id,product_id:t.product_id,type:products.find(p=>p.id===t.product_id)?.name??'',capacity_l:undefined});}}><option value="">Select tank</option>{draft.tanks.map(t=><option key={t.tank_id} value={t.tank_id}>{t.label} ({products.find(p=>p.id===t.product_id)?.name})</option>)}</select></label>
        {field('External fuel name',s.type,v=>changeSlot(i,j,{type:v}))}
        <button type="button" onClick={()=>changeBranch(i,{slots:b.slots.filter((_,k)=>j!==k)})}>Remove slot</button>
      </div>)}
      <div className="flex gap-4"><button type="button" onClick={()=>{let slot=1;while(b.slots.some(s=>s.slot===slot))slot++;const tank=draft.tanks.find(t=>!draft.branches.some(b=>b.slots.some(s=>s.tank_id===t.tank_id)));changeBranch(i,{register_count:Math.max(b.register_count,slot*12),slots:[...b.slots,{slot,type:tank?products.find(p=>p.id===tank.product_id)?.name??'':'',tank_id:tank?.tank_id,product_id:tank?.product_id}]});}}>Add slot</button><button type="button" disabled={busy} onClick={()=>probe(b)}>Test controller</button><button type="button" disabled={busy} onClick={()=>probe(b,true)}>Find controllers</button><button type="button" onClick={()=>{setFound(null);setDraft({...draft,branches:draft.branches.filter((_,j)=>j!==i)});}}>Remove controller</button></div>
    </div>)}
    <button type="button" onClick={()=>{let id=1;while(draft.branches.some(b=>b.id===id))id++;setDraft({...draft,branches:[...draft.branches,{id,name:`Controller ${id}`,host:'',port:502,unit_id:1,start_register:1000,address_base:1,register_count:12,word_order:'ABCD',height_unit:'mm',slots:[]}]});}}>Add controller</button>
    <details className="space-y-3"><summary>External reporting</summary>
      <label className="flex gap-2"><input type="checkbox" checked={draft.export_enabled ?? true} onChange={e=>setDraft({...draft,export_enabled:e.target.checked})}/>Enable external reporting</label>
      {field('API URL (optional)',draft.api_url,v=>setDraft({...draft,api_url:v}))}
      <p className="text-xs">Stored token: {config.auth?.api_token_set?'yes':'no'} · Stored password: {config.auth?.password_set?'yes':'no'}</p>
      <div className="grid grid-cols-2 gap-2">{(['api_token','username','password','login_url'] as const).map(key=><div key={key}>{field(key.replaceAll('_',' '),auth===null?'':auth?.[key]??(key==='username'||key==='login_url'?config.auth?.[key]??'':''),v=>setAuth({... (auth===null?{api_token:'',username:'',password:'',login_url:''}:auth),[key]:v}),key==='password'||key==='api_token'?'password':'text')}</div>)}</div>
      <button type="button" onClick={()=>setAuth(null)}>Clear stored credentials</button>
      {!!config.environment_overrides?.length&&<p className="text-xs">Environment overrides: {config.environment_overrides.join(', ')}. Update these in the service environment.</p>}
      <p className="text-xs">Pending exports: {config.pending_exports??0}{config.export_error?` · ${config.export_error}`:''}</p>
    </details>
    {error&&<p role="alert" className="text-accent-red">{error}</p>}{message&&<p role="status">{message}</p>}
    <button type="button" disabled={busy} onClick={save} className="rounded bg-accent-blue text-white px-4 py-2">{busy?'Working…':'Save ATG settings'}</button>
    </fieldset>
  </section>;
}
