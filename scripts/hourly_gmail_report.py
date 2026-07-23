import base64, email, html, imaplib, json, os, re, sys
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header
from email.policy import default
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo
from PIL import Image, ImageDraw, ImageFont

TZ=ZoneInfo(os.getenv('REPORT_TIMEZONE','Europe/Moscow'))
MINUTES=int(os.getenv('LOOKBACK_MINUTES','65'))
REPORT=Path('reports/latest.txt'); STATE=Path('state/gmail_monitor.json')
IMAGE=Path('/tmp/gmail_report.png'); CAPTION=Path('/tmp/gmail_caption.txt')
LABEL=os.getenv('ONE_TIME_LABEL','Одноразовые письма')

class HTMLText(HTMLParser):
    def __init__(self): super().__init__(); self.parts=[]
    def handle_data(self,data):
        if data.strip(): self.parts.append(data.strip())

def hdecode(v):
    try: return str(make_header(decode_header(v or '—'))).strip() or '—'
    except Exception: return (v or '—').strip()

def body_text(msg):
    plain=[]; markup=[]
    for p in msg.walk() if msg.is_multipart() else [msg]:
        if p.get_content_disposition()=='attachment': continue
        raw=p.get_payload(decode=True)
        if raw is None: continue
        try: text=raw.decode(p.get_content_charset() or 'utf-8','replace')
        except LookupError: text=raw.decode('utf-8','replace')
        if p.get_content_type()=='text/plain': plain.append(text)
        elif p.get_content_type()=='text/html': markup.append(text)
    if plain: out='\n'.join(plain)
    elif markup:
        parser=HTMLText(); parser.feed('\n'.join(markup)); out=' '.join(parser.parts)
    else: out=''
    return re.sub(r'\s+',' ',html.unescape(out)).strip()[:12000]

def utf7(s):
    out=[]; buf=[]
    def flush():
        if buf:
            raw=''.join(buf).encode('utf-16be')
            out.append('&'+base64.b64encode(raw).decode().rstrip('=').replace('/',',')+'-'); buf.clear()
    for c in s:
        if 0x20<=ord(c)<=0x7e:
            flush(); out.append('&-' if c=='&' else c)
        else: buf.append(c)
    flush(); return ''.join(out)

def state_load():
    try: return json.loads(STATE.read_text(encoding='utf-8'))
    except Exception: return {'uids':[],'uidvalidity':None}

def state_save(uids,validity):
    STATE.parent.mkdir(parents=True,exist_ok=True)
    STATE.write_text(json.dumps({'updated_at':datetime.now(timezone.utc).isoformat(),'uidvalidity':validity,'uids':list(dict.fromkeys(uids))[-1500:]},ensure_ascii=False,indent=2),encoding='utf-8')

def internal_date(meta):
    m=re.search(rb'INTERNALDATE "([^"]+)"',meta)
    if not m: return None
    try: return datetime.strptime(m.group(1).decode(),'%d-%b-%Y %H:%M:%S %z')
    except ValueError: return None

def anyof(text,words): return any(w in text for w in words)

def classify(sender,subject,body):
    t=re.sub(r'\s+',' ',f'{sender} {subject} {body[:5000]}'.lower())
    risk=['unknown sign-in','unrecognized sign-in','unrecognized location','suspicious activity','unauthorized','account locked','password changed','password reset',"if this wasn't you",'if this was not you','if you did not','неизвестный вход','нераспознанный вход','не распознали','подозрительная активность','если это не вы','пароль изменен','пароль изменён','аккаунт заблокирован','взлом']
    tech=['run failed','workflow failed','build failed','deployment failed','no jobs were run','ci failed','pipeline failed','ошибка workflow','сборка завершилась ошибкой','развёртывание завершилось ошибкой']
    work=['interview','recruiter','hiring','job application','application status','job offer','vacancy','bim coordinator','bim specialist','revit','vdc','собеседование','рекрутер','вакансия','отклик','предложение о работе','работодатель']
    invite=['invitation','you are invited','meeting invitation','calendar invitation','join meeting','приглашение','вас приглашают','встреча','созвон']
    finance=['payment failed','payment due','invoice','refund','chargeback','dispute','bank transfer','card declined','overdue','счёт на оплату','платёж не прошёл','возврат средств','оспаривание платежа','банковская операция','задолженность']
    otp=['verification code','one-time code','one time code','security code','login code','код подтверждения','одноразовый код','код входа','код авторизации']
    receipt=['receipt','purchase confirmation','order confirmation','payment receipt','кассовый чек','электронный чек','чек за покупку','подтверждение покупки','ваш заказ подтверждён']
    signin=['new sign-in to your account','successful sign in','new login','вход в аккаунт','выполнен вход','новый вход']
    access=['has access to some of your google account data','получило доступ к некоторым данным','есть доступ к некоторым данным','access granted','доступ предоставлен']
    service=['subscription confirmed','email confirmed','registration confirmed','welcome to','подписка подтверждена','регистрация подтверждена','адрес электронной почты подтверждён']
    if anyof(t,risk): return 'security',False,True,'Проверить активные сеансы; при сомнениях сменить пароль.','Возможна угроза безопасности или неизвестный вход.'
    if anyof(t,tech): return 'technical',False,True,'Открыть журнал запуска и исправить первый ошибочный шаг.','Техническая автоматизация завершилась ошибкой.'
    if anyof(t,finance): return 'finance',False,True,'Проверить сумму, получателя и срок; при необходимости ответить.','Письмо связано с платежом, счётом или возвратом.'
    if anyof(t,invite): return 'invitation',False,True,'Проверить дату и подтвердить участие либо ответить.','Получено приглашение на встречу или мероприятие.'
    if anyof(t,work): return 'work',False,True,'Прочитать письмо полностью и ответить отправителю.','Получен ответ по работе, вакансии или BIM/Revit-проекту.'
    if anyof(t,otp+receipt+signin+access+service): return 'one_time',True,False,'Действий не требуется.','Одноразовое или обычное сервисное уведомление.'
    return 'informational',False,False,'Просмотреть при необходимости.','Информационное письмо без явного срочного действия.'

def fetch():
    account=os.getenv('GMAIL_EMAIL','').strip(); password=os.getenv('GMAIL_APP_PASSWORD','').replace(' ','').strip()
    if not account or not password: raise RuntimeError('Не заданы секреты GMAIL_EMAIL и GMAIL_APP_PASSWORD')
    now=datetime.now(timezone.utc); cutoff=now-timedelta(minutes=MINUTES); st=state_load(); processed=set(map(str,st.get('uids',[])))
    items=[]; archived=[]; warnings=[]; imap=imaplib.IMAP4_SSL('imap.gmail.com',993)
    try:
        imap.login(account,password); label=utf7(LABEL)
        try: imap.create(label)
        except Exception: pass
        if imap.select('INBOX',readonly=False)[0]!='OK': raise RuntimeError('Не удалось открыть INBOX')
        validity=None
        try:
            r=imap.response('UIDVALIDITY'); validity=(r[1][0].decode() if r and r[1] and r[1][0] else None)
        except Exception: pass
        if st.get('uidvalidity') and validity and st.get('uidvalidity')!=validity: processed.clear()
        status,data=imap.uid('SEARCH',None,'SINCE',cutoff.strftime('%d-%b-%Y'))
        if status!='OK': raise RuntimeError('Gmail не вернул список писем')
        for ub in (data[0].split()[-250:] if data and data[0] else []):
            uid=ub.decode()
            if uid in processed: continue
            status,parts=imap.uid('FETCH',uid,'(INTERNALDATE BODY.PEEK[])')
            pair=next((p for p in parts or [] if isinstance(p,tuple) and len(p)==2),None)
            if status!='OK' or not pair: warnings.append(f'Не удалось прочитать UID {uid}'); continue
            received=internal_date(pair[0])
            if not received or received.astimezone(timezone.utc)<cutoff: continue
            msg=email.message_from_bytes(pair[1],policy=default); sender=hdecode(msg.get('From')); subject=hdecode(msg.get('Subject')); body=body_text(msg)
            cat,one,important,action,summary=classify(sender,subject,body)
            items.append({'uid':uid,'time':received,'sender':sender,'subject':subject,'cat':cat,'one':one,'important':important,'action':action,'summary':summary})
            if one:
                a=imap.uid('STORE',uid,'+X-GM-LABELS',f'("{label}")')[0]
                b=imap.uid('STORE',uid,'-X-GM-LABELS','(\\Inbox)')[0]
                if a=='OK' and b=='OK': archived.append(uid)
                else: warnings.append(f'Не удалось переместить «{subject}»')
        processed.update(x['uid'] for x in items); state_save(sorted(processed,key=lambda x:int(x)),validity)
        return sorted(items,key=lambda x:x['time']),archived,warnings
    finally:
        try: imap.close()
        except Exception: pass
        try: imap.logout()
        except Exception: pass

def sender_short(s): return re.sub(r'\s*<[^>]+>\s*','',s).strip().strip('"') or s

def build(items,archived,warnings):
    now=datetime.now(TZ); start=now-timedelta(minutes=MINUTES); important=[x for x in items if x['important']]
    m={'technical':sum(x['cat']=='technical' for x in items),'work':sum(x['cat']=='work' for x in items),'invitation':sum(x['cat']=='invitation' for x in items),'finance':sum(x['cat']=='finance' for x in items),'security':sum(x['cat']=='security' for x in items),'one_time':len(archived),'important':len(important),'total':len(items)}
    lines=[f"Проверка Gmail: {now.strftime('%d.%m.%Y, %H:%M')} МСК",f"Период: {start.strftime('%d.%m.%Y, %H:%M')} — {now.strftime('%d.%m.%Y, %H:%M')} МСК",f"Новых писем за последние {MINUTES} минут: {len(items)}",'']
    if not items: lines+=['За выбранный период новых писем нет.','']
    elif important:
        lines+=['ВАЖНЫЕ ПИСЬМА']
        for i,x in enumerate(important,1):
            lines += [f"{i}. {x['time'].astimezone(TZ).strftime('%H:%M')} — {sender_short(x['sender'])}",f"Тема: {x['subject']}",f"Суть: {x['summary']}",f"Действие: {x['action']}",'']
    else: lines+=['Новых писем, требующих срочных действий, нет.','']
    lines += ['ИТОГ',f"Срочные/технические письма: {m['technical']}",f"Ответы по работе/учёбе: {m['work']}",f"Приглашения: {m['invitation']}",f"Финансовые вопросы: {m['finance']}",f"Угрозы безопасности: {m['security']}",f"Одноразовые письма: {m['one_time']}"]
    if warnings: lines += ['','ПРЕДУПРЕЖДЕНИЯ']+[f'• {w}' for w in warnings[:5]]
    if important: conclusion,action=important[0]['summary'],important[0]['action']
    elif items: conclusion,action='Письма получены, но срочных действий не требуется.','Просмотреть информационные письма при необходимости.'
    else: conclusion,action='За выбранный период новых писем нет.','Действий не требуется.'
    return '\n'.join(lines).strip()+'\n',m,conclusion,action

def fonts():
    r='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'; b='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
    return {k:ImageFont.truetype(b if bold else r,size) for k,size,bold in [('title',62,1),('sub',27,0),('big',104,1),('card',30,1),('body',25,0),('bold',25,1),('small',20,0)]}

def wrap(draw,xy,text,font,color,width,limit=2):
    x,y=xy; words=text.split(); lines=[]; cur=''
    for w in words:
        trial=(cur+' '+w).strip()
        if len(trial)<=width: cur=trial
        else: lines.append(cur); cur=w
    if cur: lines.append(cur)
    if len(lines)>limit: lines=lines[:limit]; lines[-1]=lines[-1].rstrip()+'…'
    for line in lines: draw.text((x,y),line,font=font,fill=color); y+=35

def render(report,m,conclusion,action):
    f=fonts(); W,H=1080,1175; img=Image.new('RGB',(W,H),'#07111f'); d=ImageDraw.Draw(img)
    for y in range(H):
        t=y/(H-1); d.line((0,y,W,y),fill=(7+int(11*t),17+int(18*t),31+int(28*t)))
    for x,w,h in [(0,80,240),(95,115,210),(220,95,235),(335,130,190),(475,90,230),(590,120,200),(735,100,220),(860,140,180),(1000,80,240)]:
        top=260-h; d.rectangle((x,top,min(x+w,W),260),fill='#091421')
        for wx in range(x+15,min(x+w-10,W),25):
            for wy in range(top+18,248,27): d.rectangle((wx,wy,wx+6,wy+9),fill='#244763')
    d.polygon([(0,1180),(1080,1080),(1080,1350),(0,1350)],fill='#07101a'); d.rounded_rectangle((635,965,1015,1195),18,fill='#111b28',outline='#42556b',width=3); d.rectangle((665,995,985,1160),fill='#162c40'); d.polygon([(605,1195),(1035,1195),(1080,1240),(560,1240)],fill='#172230')
    d.rounded_rectangle((42,38,1038,1150),30,fill='#0a1828',outline='#33506b',width=2); d.rounded_rectangle((68,64,1012,190),26,fill='#0d2138',outline='#2a86ff',width=3)
    d.rounded_rectangle((92,88,156,152),14,fill='#e94646'); d.polygon([(99,99),(124,122),(149,99),(149,112),(124,134),(99,112)],fill='white'); d.text((180,77),'ОТЧЁТ ПО GMAIL',font=f['title'],fill='white')
    
    period=next((x.replace('Период: ','') for x in report.splitlines() if x.startswith('Период: ')),f'последние {MINUTES} минут'); d.rounded_rectangle((68,218,1012,294),20,fill='#0c2339',outline='#284c6a',width=2); d.text((98,240),f'ПЕРИОД: {period}',font=f['body'],fill='#d5e9fa')
    d.rounded_rectangle((68,322,500,542),26,fill='#0c3153',outline='#3ca6ff',width=3); d.text((98,350),'НОВЫХ ПИСЕМ',font=f['card'],fill='#9bd5ff'); d.text((98,397),str(m['total']),font=f['big'],fill='#69e19a' if m['total']==0 else 'white')
    if 'ОШИБКА ПРОВЕРКИ' in report:
        fill,outline,title,label,text='#3a2118','#ff6b57','#ff8d79','ОШИБКА GMAIL','Проверка почты не выполнена'
    elif m['important']:
        fill,outline,title,label,text='#3a2118','#ff6b57','#ff8d79','ТРЕБУЕТ ВНИМАНИЯ',f"Важных писем: {m['important']}"
    else:
        fill,outline,title,label,text='#173024','#45c777','#78e5a0','СТАТУС','Срочных действий не требуется'
    d.rounded_rectangle((530,322,1012,542),26,fill=fill,outline=outline,width=3); d.text((562,351),label,font=f['card'],fill=title); wrap(d,(562,410),text,f['bold'],'white',30,3)
    rows=[('СРОЧНЫЕ / ТЕХНИЧЕСКИЕ',m['technical'],'#ff6767'),('РАБОТА / УЧЁБА',m['work'],'#55c98a'),('ПРИГЛАШЕНИЯ',m['invitation'],'#a17aff'),('ФИНАНСЫ',m['finance'],'#ffc34a'),('БЕЗОПАСНОСТЬ',m['security'],'#ff6b62' if m['security'] else '#55c98a')]; y=574
    for label,value,accent in rows:
        d.rounded_rectangle((68,y,1012,y+82),19,fill='#0b1d30',outline='#294b69',width=2); d.ellipse((92,y+21,132,y+61),fill=accent); d.text((158,y+23),label,font=f['bold'],fill='#dbeafb'); d.rounded_rectangle((906,y+18,978,y+64),16,fill='#102b45'); d.text((942,y+25),str(value),font=f['bold'],fill='white',anchor='mm'); y+=94
    d.rounded_rectangle((68,1044,1012,1130),20,fill='#0d2740',outline='#3d93cc',width=2); d.text((98,1069),'ОДНОРАЗОВЫЕ ПИСЬМА',font=f['bold'],fill='#9bd5ff'); d.text((626,1069),f"Перемещено: {m['one_time']}",font=f['bold'],fill='white')
    
    img.save(IMAGE,optimize=True,quality=92)

def caption(report,m,conclusion,action):
    checked=report.splitlines()[0].replace('Проверка Gmail: ',''); period=next((x.replace('Период: ','') for x in report.splitlines() if x.startswith('Период: ')),f'последние {MINUTES} минут')
    text=f"📬 Отчёт по Gmail\n\n🕒 Проверка: {checked}\n⏱ Период: {period}\n\n📨 Новых писем: {m['total']}\n⚠️ Требуют внимания: {m['important']}\n🗂 Одноразовых перемещено: {m['one_time']}\n\nГлавное:\n{conclusion}\n\nЧто сделать:\n{action}\n\n🚨 Срочные/технические: {m['technical']}\n💼 Работа/учёба: {m['work']}\n📅 Приглашения: {m['invitation']}\n💳 Финансы: {m['finance']}\n🔐 Безопасность: {m['security']}"
    CAPTION.write_text(text[:997].rstrip()+'…' if len(text)>1000 else text,encoding='utf-8')

def error_report(err):
    now=datetime.now(TZ)
    start=now-timedelta(minutes=MINUTES)
    auth_failed='AUTHENTICATIONFAILED' in str(err) or 'Invalid credentials' in str(err)
    conclusion='Google отклонил пароль приложения Gmail.' if auth_failed else 'Не удалось получить данные Gmail.'
    action='Создать новый пароль приложения Google и обновить GMAIL_APP_PASSWORD.' if auth_failed else 'Проверить секреты Gmail и журнал GitHub Actions.'
    report=f"Проверка Gmail: {now.strftime('%d.%m.%Y, %H:%M')} МСК\nПериод: {start.strftime('%d.%m.%Y, %H:%M')} — {now.strftime('%d.%m.%Y, %H:%M')} МСК\nНовых писем за последние {MINUTES} минут: 0\n\nОШИБКА ПРОВЕРКИ\nСуть: {err}\nДействие: {action}\n\nИТОГ\nСрочные/технические письма: 0\nОтветы по работе/учёбе: 0\nПриглашения: 0\nФинансовые вопросы: 0\nУгрозы безопасности: 0\nОдноразовые письма: 0\n"
    m={'technical':0,'work':0,'invitation':0,'finance':0,'security':0,'one_time':0,'important':0,'total':0}
    return report,m,conclusion,action

def main():
    try: report,m,conclusion,action=build(*fetch())
    except Exception as e: report,m,conclusion,action=error_report(str(e))
    REPORT.parent.mkdir(parents=True,exist_ok=True); REPORT.write_text(report,encoding='utf-8'); render(report,m,conclusion,action); caption(report,m,conclusion,action); print(report)
if __name__=='__main__': main()
