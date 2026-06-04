// ────────────────────────────────────────────────────────────────
//  텔레그램 → Netlify Functions → 구글 캘린더 → 텔레그램
//  개인용 일정 조회 + 추가 봇
// ────────────────────────────────────────────────────────────────
const { JWT } = require("google-auth-library");

// 한국 시간(Asia/Seoul)은 항상 UTC+9, 서머타임 없음
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];

// 조회 + 추가(쓰기) 모두 가능한 권한
const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// ── 환경변수 ─────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
// Netlify 환경변수에 줄바꿈이 \n 문자로 들어가므로 실제 줄바꿈으로 복원
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ── 날짜 계산 (KST 기준) ─────────────────────────────────────────
// 오늘 0시 ~ 다음날 0시 (KST) 구간을 UTC Date 로 반환
function todayRange() {
  const seoulNow = new Date(Date.now() + KST_OFFSET_MS);
  const startMs =
    Date.UTC(seoulNow.getUTCFullYear(), seoulNow.getUTCMonth(), seoulNow.getUTCDate()) -
    KST_OFFSET_MS;
  return { start: new Date(startMs), end: new Date(startMs + 24 * 60 * 60 * 1000) };
}

// 이번 주 월요일 0시 ~ 다음 주 월요일 0시 (KST)
function weekRange() {
  const seoulNow = new Date(Date.now() + KST_OFFSET_MS);
  const day = seoulNow.getUTCDay(); // 0(일) ~ 6(토)
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const startMs =
    Date.UTC(
      seoulNow.getUTCFullYear(),
      seoulNow.getUTCMonth(),
      seoulNow.getUTCDate() + diffToMonday
    ) - KST_OFFSET_MS;
  return { start: new Date(startMs), end: new Date(startMs + 7 * 24 * 60 * 60 * 1000) };
}

// 오늘로부터 n일 뒤의 KST 날짜 정보
function kstDateParts(daysFromToday = 0) {
  const seoul = new Date(Date.now() + KST_OFFSET_MS);
  const t = new Date(
    Date.UTC(seoul.getUTCFullYear(), seoul.getUTCMonth(), seoul.getUTCDate() + daysFromToday)
  );
  return {
    ymd: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    m: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    w: WEEKDAYS_KO[t.getUTCDay()],
  };
}

// "YYYY-MM-DD" → {m, day, w}
function partsFromYmd(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return { m, day: d, w: WEEKDAYS_KO[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] };
}

// "YYYY-MM-DD" → 다음 날 "YYYY-MM-DD" (종일 일정 end용)
function nextDateStr(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// UTC Date → KST "HH:MM"
function fmtTime(date) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  return `${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}`;
}

// UTC Date → KST "6월 4일 (목)"
function fmtDateHeader(date) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  return `${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일 (${WEEKDAYS_KO[k.getUTCDay()]})`;
}

// 종일 일정 그룹핑용 KST 날짜 키
function dayKey(date) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}-${k.getUTCMonth()}-${k.getUTCDate()}`;
}

// "14:00" → "15:00" (종료시간 미입력 시 1시간 기본값)
function addOneHour(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${pad((h + 1) % 24)}:${pad(m)}`;
}

// ── 구글 인증 토큰 ───────────────────────────────────────────────
async function getToken() {
  const client = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: SCOPES,
  });
  const { token } = await client.getAccessToken();
  return token;
}

// ── 구글 캘린더: 일정 조회 ───────────────────────────────────────
async function getEvents(timeMin, timeMax) {
  const token = await getToken();
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/` +
    `${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events?${params.toString()}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Calendar list ${res.status}: ${await res.text()}`);
  return (await res.json()).items || [];
}

// ── 구글 캘린더: 일정 추가 ───────────────────────────────────────
async function createEvent(ymd, parsed) {
  const token = await getToken();
  let body;
  if (parsed.allDay) {
    body = { summary: parsed.title, start: { date: ymd }, end: { date: nextDateStr(ymd) } };
  } else {
    body = {
      summary: parsed.title,
      start: { dateTime: `${ymd}T${parsed.startTime}:00+09:00`, timeZone: "Asia/Seoul" },
      end: { dateTime: `${ymd}T${parsed.endTime}:00+09:00`, timeZone: "Asia/Seoul" },
    };
  }
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/` +
    `${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Calendar create ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── 입력 텍스트 → 일정 파싱 ──────────────────────────────────────
//  "14:00 회의"            → 14:00~15:00 회의
//  "14:00-15:30 점심"      → 14:00~15:30 점심
//  "종일: 휴가" / "종일 휴가" → 종일 일정
//  "회의"                  → 종일 일정 (시간 없을 때)
function parseEventInput(text) {
  const raw = (text || "").trim();
  if (!raw) return null;

  let m = raw.match(/^(\d{1,2}):(\d{2})\s*[-~]\s*(\d{1,2}):(\d{2})\s+(.+)$/);
  if (m) {
    return {
      allDay: false,
      startTime: `${pad(+m[1])}:${m[2]}`,
      endTime: `${pad(+m[3])}:${m[4]}`,
      title: m[5].trim(),
    };
  }
  m = raw.match(/^(\d{1,2}):(\d{2})\s+(.+)$/);
  if (m) {
    const startTime = `${pad(+m[1])}:${m[2]}`;
    return { allDay: false, startTime, endTime: addOneHour(startTime), title: m[3].trim() };
  }
  m = raw.match(/^종일\s*:?\s*(.+)$/);
  if (m) return { allDay: true, title: m[1].trim() };

  // 시간 표기가 전혀 없으면 종일 일정으로 처리
  return { allDay: true, title: raw };
}

// ── 조회 결과 포맷팅 ─────────────────────────────────────────────
function isAllDay(ev) {
  return !!(ev.start && ev.start.date && !ev.start.dateTime);
}

function eventLine(ev) {
  const title = (ev.summary || "(제목 없음)").trim();
  if (isAllDay(ev)) return `🔸 종일  ${title}`;
  return `🕒 ${fmtTime(new Date(ev.start.dateTime))}  ${title}`;
}

function formatToday(events) {
  if (events.length === 0) return "📭 오늘은 등록된 일정이 없어요. 푹 쉬세요! ☕";
  return `📅 오늘 일정이에요!\n\n${events.map(eventLine).join("\n")}`;
}

function formatWeek(events) {
  if (events.length === 0) return "📭 이번 주는 등록된 일정이 없어요. 여유로운 한 주네요! 🌿";
  const groups = new Map();
  for (const ev of events) {
    const date = new Date(ev.start.dateTime || ev.start.date);
    const key = dayKey(date);
    if (!groups.has(key)) groups.set(key, { date, items: [] });
    groups.get(key).items.push(ev);
  }
  const blocks = [];
  for (const { date, items } of groups.values()) {
    const lines = items.map((ev) => "   " + eventLine(ev));
    blocks.push(`📌 ${fmtDateHeader(date)}\n${lines.join("\n")}`);
  }
  return `🗓️ 이번 주 일정이에요!\n\n${blocks.join("\n\n")}`;
}

// ── 인라인 키보드 ────────────────────────────────────────────────
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📅 오늘 일정", callback_data: "view:today" }],
      [{ text: "🗓️ 이번 주 일정", callback_data: "view:week" }],
      [{ text: "✏️ 일정 추가", callback_data: "add:menu" }],
    ],
  };
}

// 날짜 선택 키보드 (오늘부터 7일)
function datePickerKeyboard() {
  const btns = [];
  for (let i = 0; i < 7; i++) {
    const p = kstDateParts(i);
    const prefix = i === 0 ? "오늘 " : i === 1 ? "내일 " : "";
    btns.push({ text: `${prefix}${p.m}/${p.day}(${p.w})`, callback_data: `add:date:${p.ymd}` });
  }
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  return { inline_keyboard: rows };
}

// ── 텔레그램 전송 ────────────────────────────────────────────────
async function sendMessage(chatId, text, extra = {}) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, ...extra }),
  });
}

async function answerCallback(id, text = "") {
  await fetch(`${TG_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text }),
  });
}

const MENU_TEXT =
  "안녕하세요! 👋 무엇을 도와드릴까요?\n\n아래 버튼을 누르거나 이렇게 입력해도 돼요:\n• 오늘 일정\n• 이번 주 일정\n• 일정 추가";

// ── 명령 해석 ────────────────────────────────────────────────────
function detectIntent(text) {
  const t = (text || "").replace(/\s+/g, "");
  if (t.includes("이번주") || t.includes("주간") || t === "/week") return "week";
  if (t.includes("추가") || t.includes("변경") || t.includes("등록") || t === "/add")
    return "add";
  if (t.includes("오늘") || t === "/today") return "today";
  if (t === "/start" || t.includes("메뉴") || t.includes("도움") || t === "/help")
    return "menu";
  return "menu";
}

// ── 콜백(버튼) 처리 ──────────────────────────────────────────────
async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data || "";
  await answerCallback(cb.id);

  if (data === "view:today") {
    const { start, end } = todayRange();
    await sendMessage(chatId, formatToday(await getEvents(start, end)));
  } else if (data === "view:week") {
    const { start, end } = weekRange();
    await sendMessage(chatId, formatWeek(await getEvents(start, end)));
  } else if (data === "add:menu") {
    await sendMessage(chatId, "📅 어느 날짜에 일정을 추가할까요?", {
      reply_markup: datePickerKeyboard(),
    });
  } else if (data.startsWith("add:date:")) {
    const ymd = data.slice("add:date:".length);
    const p = partsFromYmd(ymd);
    const prompt =
      `✏️ ${p.m}월 ${p.day}일(${p.w}) 에 추가할 일정을 입력해 주세요.\n\n` +
      "예시:\n" +
      "• 14:00 회의\n" +
      "• 14:00-15:30 점심 약속\n" +
      "• 종일: 휴가\n\n" +
      "이 메시지에 답장으로 보내주세요 👇\n\n" +
      `[DATE:${ymd}]`;
    await sendMessage(chatId, prompt, {
      reply_markup: { force_reply: true, input_field_placeholder: "예: 14:00 회의" },
    });
  }
}

// ── 메인 핸들러 ──────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 200, body: "ok" };

  let update;
  try {
    update = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 200, body: "ok" };
  }

  try {
    // 1) 버튼 클릭
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return { statusCode: 200, body: "ok" };
    }

    const message = update.message || update.edited_message;
    if (!message || !message.chat) return { statusCode: 200, body: "ok" };
    const chatId = message.chat.id;

    // 2) "일정 추가" 흐름의 답장(force_reply) 처리
    const replyText = message.reply_to_message && message.reply_to_message.text;
    const dateTag = replyText && replyText.match(/\[DATE:(\d{4}-\d{2}-\d{2})\]/);
    if (dateTag) {
      const ymd = dateTag[1];
      const parsed = parseEventInput(message.text);
      if (!parsed) {
        await sendMessage(chatId, "⚠️ 형식을 이해하지 못했어요. 예: 14:00 회의");
        return { statusCode: 200, body: "ok" };
      }
      await createEvent(ymd, parsed);
      const p = partsFromYmd(ymd);
      const when = parsed.allDay ? "종일" : `${parsed.startTime}–${parsed.endTime}`;
      await sendMessage(
        chatId,
        `✅ 일정이 추가되었어요!\n\n📅 ${p.m}월 ${p.day}일(${p.w})\n🕒 ${when}  ${parsed.title}`
      );
      return { statusCode: 200, body: "ok" };
    }

    // 3) 일반 명령
    const intent = detectIntent(message.text);
    if (intent === "today") {
      const { start, end } = todayRange();
      await sendMessage(chatId, formatToday(await getEvents(start, end)));
    } else if (intent === "week") {
      const { start, end } = weekRange();
      await sendMessage(chatId, formatWeek(await getEvents(start, end)));
    } else if (intent === "add") {
      await sendMessage(chatId, "📅 어느 날짜에 일정을 추가할까요?", {
        reply_markup: datePickerKeyboard(),
      });
    } else {
      await sendMessage(chatId, MENU_TEXT, { reply_markup: mainMenuKeyboard() });
    }
  } catch (err) {
    console.error(err);
    // 오류가 나도 텔레그램에는 200을 돌려줘야 재전송이 안 됩니다.
    const chatId =
      (update.message && update.message.chat && update.message.chat.id) ||
      (update.callback_query &&
        update.callback_query.message &&
        update.callback_query.message.chat.id);
    if (chatId) await sendMessage(chatId, "⚠️ 처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.");
  }

  return { statusCode: 200, body: "ok" };
};
