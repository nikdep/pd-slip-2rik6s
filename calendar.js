/* Historical accounting tiles + phone-friendly month calendar overlay. */
(() => {
  const TZ = "America/Toronto", $ = (s) => document.querySelector(s), money = (x) => "$" + Number(x || 0).toFixed(2);
  const today = () => new Intl.DateTimeFormat("en-CA", {timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
  const shift = (d,n) => { const x=new Date(d+"T12:00:00Z"); x.setUTCDate(x.getUTCDate()+n); return x.toISOString().slice(0,10); };
  let date=today(), month=date.slice(0,7), open=false, index=[], suppress=false;
  const get = (u) => fetch(u+"?t="+Date.now(), {cache:"no-store"}).then(r => {if(!r.ok) throw Error(r.status); return r.json();});
  const summary = (d) => {
    if (!d || d >= today()) return;
    const bets=d.bets||[], lost=bets.filter(b=>b.status==="lost"), won=bets.filter(b=>b.status==="won");
    const staked=bets.reduce((a,b)=>a+Number(b.stake||0),0), potential=bets.reduce((a,b)=>a+Number(b.payout||0),0);
    const lostStake=lost.reduce((a,b)=>a+Number(b.stake||0),0), wonProfit=won.reduce((a,b)=>a+Number(b.payout||0)-(b.bonus?0:Number(b.stake||0)),0), net=wonProfit-lostStake;
    const c=net>0?"var(--green)":net<0?"var(--red)":"var(--muted)";
    const bonus=bets.reduce((a,b)=>a+Number(b.bonus_stake||0),0);
    $("#summary").innerHTML=`<div class="summary historical"><div class="stat"><div class="k">Staked</div><div class="v">${money(staked)}</div></div><div class="stat"><div class="k">Potential</div><div class="v">${money(potential)}</div></div><div class="stat"><div class="k">Lost</div><div class="v" style="color:var(--red)">${money(lostStake)}</div></div><div class="stat"><div class="k">Won</div><div class="v" style="color:var(--green)">${money(wonProfit)}</div></div><div class="stat net"><div class="k">Net</div><div class="v" style="color:${c}">${money(net)}</div></div></div>${bonus?`<div class="bonus-note">Bonus stake: ${money(bonus)} (not cash staked)</div>`:""}`;
  };
  const normalize=()=>{ const b=$(".daylabel"); if(b){b.dataset.calendar="1";if(b.tagName!=="BUTTON") b.outerHTML=b.outerHTML.replace("<span","<button").replace("</span>","</button>");} };
  const patch=()=>{ normalize(); if(open) draw(); get(date===today()?"bets.json":`days/${date}.json`).then(summary).catch(()=>{}); };
  function draw(){ const e=$("#calendar"); if(!e)return; const [y,m]=month.split("-").map(Number), f=new Date(Date.UTC(y,m-1,1)), last=new Date(Date.UTC(y,m,0)), meta=Object.fromEntries(index.map(x=>[x.date,x])); let h=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(x=>`<div class="caldow">${x}</div>`).join(""); for(let i=0;i<f.getUTCDay();i++)h+=`<div class="calcell blank"></div>`; for(let n=1;n<=last.getUTCDate();n++){const d=`${y}-${String(m).padStart(2,"0")}-${String(n).padStart(2,"0")}`,x=meta[d]||{},net=Number(x.net||0),cl=net>0?"positive":net<0?"negative":x.open?"open":"neutral"; h+=`<button class="calcell ${cl}${d===today()?" today":""}" data-calendar-day="${d}"><b>${n}</b>${x.bets?`<small>${net>0?"+":""}${money(net)}</small>`:""}</button>`;} e.innerHTML=`<div class="calhead"><button data-cal-month="-1">‹</button><b>${new Date(Date.UTC(y,m-1,15)).toLocaleDateString("en-US",{month:"long",year:"numeric",timeZone:"UTC"})}</b><button data-cal-month="1">›</button></div><div class="calgrid">${h}</div>`; e.hidden=!open; }
  document.addEventListener("click", e => {
    if(suppress)return;
    const m=e.target.closest("[data-cal-month]"); if(m){const [y,mo]=month.split("-").map(Number),x=new Date(Date.UTC(y,mo-1+Number(m.dataset.calMonth),15));month=`${x.getUTCFullYear()}-${String(x.getUTCMonth()+1).padStart(2,"0")}`;draw();return;}
    const c=e.target.closest("[data-calendar-day]"); if(c){const target=c.dataset.calendarDay, cur=date; open=false; date=target; suppress=true; let n=(new Date(target)-new Date(cur))/86400000, sel; while(n<0){sel=$("[data-day-shift=\"-1\"]");sel&&sel.click();n++;}while(n>0){sel=$("[data-day-shift=\"1\"]");sel&&sel.click();n--;}suppress=false;patch();return;}
    if(e.target.closest("[data-calendar]")){open=!open;month=date.slice(0,7);draw();return;}
    const s=e.target.closest("[data-day-shift]"), t=e.target.closest("[data-day-today]"); if(s){date=shift(date,Number(s.dataset.dayShift));open=false;setTimeout(patch,50);} else if(t){date=today();month=date.slice(0,7);open=false;setTimeout(patch,50);}
  }, true);
  new MutationObserver(()=>{ if(!suppress) normalize(); }).observe(document.body,{childList:true,subtree:true});
  get("days/index.json").then(d=>{index=d.days||[];patch();}).catch(()=>patch());
})();
