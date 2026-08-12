"use client";

import {
  CheckCircle2, LoaderCircle, ShieldCheck, TriangleAlert, UserPlus, UserRound,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Role = "admin" | "archive_manager" | "reviewer" | "viewer";
type DirectoryUser = {
  email:string; displayName:string; role:Role; roleLabel:string;
  unit:string; active:boolean; createdAt:string; updatedAt:string;
};
type AdminEvent = {
  id:string; actor:string; targetEmail:string; action:"user.created"|"user.updated";
  previousState:{role:Role;unit:string;active:boolean}|null;
  newState:{role:Role;unit:string;active:boolean};
  createdAt:string;
};
type Directory = {
  users:DirectoryUser[];
  roles:{value:Role;label:string}[];
  units:string[];
  events:AdminEvent[];
  currentUser:string;
};

const ALL_UNITS = "*";

function formatMoment(value:string) {
  const parsed = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? value
    : parsed.toLocaleString("tr-TR", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });
}

function unitLabel(unit:string) {
  return unit === ALL_UNITS ? "Bütün müdürlükler" : unit;
}

/** Denetim satırını okunur cümleye çevirir; ham JSON gösterilmez. */
function describeEvent(event:AdminEvent, roles:{value:Role;label:string}[]) {
  const label = (role:Role) => roles.find((entry) => entry.value === role)?.label ?? role;
  if (event.action === "user.created") {
    return `${label(event.newState.role)} olarak eklendi · ${unitLabel(event.newState.unit)}`;
  }
  const changes:string[] = [];
  if (event.previousState && event.previousState.role !== event.newState.role) {
    changes.push(`rol: ${label(event.previousState.role)} → ${label(event.newState.role)}`);
  }
  if (event.previousState && event.previousState.unit !== event.newState.unit) {
    changes.push(`müdürlük: ${unitLabel(event.previousState.unit)} → ${unitLabel(event.newState.unit)}`);
  }
  if (event.previousState && event.previousState.active !== event.newState.active) {
    changes.push(event.newState.active ? "erişim açıldı" : "erişim kapatıldı");
  }
  return changes.length ? changes.join(" · ") : "kayıt güncellendi";
}

export function UsersScreen() {
  const [directory,setDirectory]=useState<Directory|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busyEmail,setBusyEmail]=useState("");
  const [adding,setAdding]=useState(false);
  const [draft,setDraft]=useState({email:"",displayName:"",role:"viewer" as Role,unit:ALL_UNITS});

  const load=useCallback(async()=>{
    try {
      const response=await fetch("/api/users");
      const payload=await response.json() as Directory&{error?:string};
      if(!response.ok){setError(payload.error??"Kullanıcı listesi alınamadı.");setDirectory(null);return}
      setDirectory(payload);setError("");
    } catch {
      setError("Kullanıcı listesi alınamadı; bağlantıyı kontrol edin.");
    } finally { setLoading(false); }
  },[]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{void load()},[load]);

  const send=async(method:"POST"|"PATCH",body:Record<string,unknown>,successMessage:string)=>{
    setError("");
    const response=await fetch("/api/users",{method,headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const payload=await response.json().catch(()=>null) as {error?:string}|null;
    if(!response.ok){setError(payload?.error??"İşlem tamamlanamadı.");return false}
    setNotice(successMessage);
    await load();
    return true;
  };

  const changeUser=async(user:DirectoryUser,patch:Partial<{role:Role;unit:string;active:boolean}>,message:string)=>{
    setBusyEmail(user.email);
    try { await send("PATCH",{email:user.email,...patch},message); }
    finally { setBusyEmail(""); }
  };

  const addUser=async(event:React.FormEvent)=>{
    event.preventDefault();
    setAdding(true);
    try {
      const created=await send("POST",draft,`${draft.email} eklendi`);
      if(created) setDraft({email:"",displayName:"",role:"viewer",unit:ALL_UNITS});
    } finally { setAdding(false); }
  };

  if(loading) return <section className="panel"><p className="table-empty"><LoaderCircle className="spin" size={16}/> Kullanıcılar yükleniyor…</p></section>;
  if(!directory) return <section className="panel"><p className="table-empty">{error||"Kullanıcı listesi görüntülenemiyor."}</p></section>;

  const { users, roles, units, events, currentUser } = directory;
  const activeAdmins=users.filter((user)=>user.role==="admin"&&user.active).length;

  return <>
    <section className="heading"><div><p className="eyebrow">YÖNETİM</p><h1>Kullanıcılar</h1>
      <span>Arşiv erişimi, rol ve müdürlük kapsamı bu ekrandan verilir. Her değişiklik denetim kaydına yazılır.</span></div></section>

    {error?<div className="user-alert danger" role="alert"><TriangleAlert size={17}/><span>{error}</span></div>:null}
    {notice?<div className="user-alert success" role="status"><CheckCircle2 size={17}/><span>{notice}</span></div>:null}

    <section className="panel">
      <header><div><h2>Yetkili kullanıcılar</h2><p>{users.length} kayıt · {activeAdmins} aktif yönetici</p></div></header>
      <div className="table-wrap"><table><thead><tr>
        <th>Kullanıcı</th><th>Rol</th><th>Müdürlük kapsamı</th><th>Durum</th><th>Son değişiklik</th>
      </tr></thead><tbody>
        {users.map((user)=>{
          const self=user.email===currentUser;
          // Son aktif yöneticiyi ve kendi hesabını kilitleyecek işlemler ekranda
          // da kapatılır; sunucu ayrıca reddeder (lib/user-directory.ts).
          const lastAdmin=user.role==="admin"&&user.active&&activeAdmins<=1;
          const roleLocked=self||lastAdmin||busyEmail===user.email;
          const accessLocked=self||lastAdmin||busyEmail===user.email;
          const lockReason=self?"Kendi yetkinizi değiştiremezsiniz; devir başka bir yönetici tarafından yapılır."
            :lastAdmin?"Sistemde en az bir aktif yönetici kalmalıdır.":undefined;
          return <tr key={user.email}>
            <td><div className="user-cell"><span><UserRound size={17}/></span><b>{user.displayName}<small>{user.email}{self?" · siz":""}</small></b></div></td>
            <td><select value={user.role} disabled={roleLocked} title={lockReason}
              onChange={(event)=>void changeUser(user,{role:event.target.value as Role},`${user.email} rolü güncellendi`)}>
              {roles.map((role)=><option key={role.value} value={role.value}>{role.label}</option>)}
            </select></td>
            <td><select value={user.unit} disabled={busyEmail===user.email}
              onChange={(event)=>void changeUser(user,{unit:event.target.value},`${user.email} müdürlük kapsamı güncellendi`)}>
              <option value={ALL_UNITS}>Bütün müdürlükler</option>
              {units.map((unit)=><option key={unit} value={unit}>{unit}</option>)}
              {/* Sözlükte olmayan eski değer varsa seçim kaybolmasın. */}
              {user.unit!==ALL_UNITS&&!units.includes(user.unit)?<option value={user.unit}>{user.unit}</option>:null}
            </select></td>
            <td><span className={`status ${user.active?"success":"danger"}`}><i/>{user.active?"Erişim açık":"Erişim kapalı"}</span></td>
            <td><div className="user-actions"><small>{formatMoment(user.updatedAt)}</small>
              <button className="outline" disabled={accessLocked} title={lockReason}
                onClick={()=>void changeUser(user,{active:!user.active},user.active?`${user.email} erişimi kapatıldı`:`${user.email} erişimi açıldı`)}>
                {busyEmail===user.email?<LoaderCircle className="spin" size={14}/>:<ShieldCheck size={14}/>}
                {user.active?"Erişimi kapat":"Erişimi aç"}
              </button></div></td>
          </tr>;
        })}
      </tbody></table></div>
    </section>

    <section className="panel">
      <header><div><h2>Kullanıcı ekle</h2><p>Kişi ilk girişinde bu rol ve kapsamla karşılanır.</p></div></header>
      <form className="user-form" onSubmit={addUser}>
        <label>E-posta<input type="email" required value={draft.email} placeholder="ad.soyad@sivas.bel.tr"
          onChange={(event)=>setDraft({...draft,email:event.target.value})}/></label>
        <label>Ad soyad<input value={draft.displayName} placeholder="İsteğe bağlı"
          onChange={(event)=>setDraft({...draft,displayName:event.target.value})}/></label>
        <label>Rol<select value={draft.role} onChange={(event)=>setDraft({...draft,role:event.target.value as Role})}>
          {roles.map((role)=><option key={role.value} value={role.value}>{role.label}</option>)}
        </select></label>
        <label>Müdürlük kapsamı<select value={draft.unit} onChange={(event)=>setDraft({...draft,unit:event.target.value})}>
          <option value={ALL_UNITS}>Bütün müdürlükler</option>
          {units.map((unit)=><option key={unit} value={unit}>{unit}</option>)}
        </select></label>
        <button className="primary" type="submit" disabled={adding}>
          {adding?<LoaderCircle className="spin" size={15}/>:<UserPlus size={15}/>} Kullanıcıyı ekle
        </button>
      </form>
    </section>

    <section className="panel">
      <header><div><h2>Son yetki değişiklikleri</h2><p>Değişmez denetim kaydı</p></div></header>
      {events.length
        ?<ul className="user-events">{events.map((event)=><li key={event.id}>
          <b>{event.targetEmail}</b><span>{describeEvent(event,roles)}</span>
          <small>{event.actor} · {formatMoment(event.createdAt)}</small>
        </li>)}</ul>
        :<p className="table-empty">Henüz yetki değişikliği yapılmadı.</p>}
    </section>
  </>;
}
