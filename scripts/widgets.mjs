// Saját profil-widgetek: terminál-kártya, hozzájárulási naptár (az adamkristof.hu-nak) és a README blog-listája.
// Futtatás: GITHUB_TOKEN=... GH_USER=adamkristoflioner node scripts/widgets.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const USER = process.env.GH_USER || 'adamkristoflioner';
const TOKEN = process.env.GITHUB_TOKEN;
const BLOG_URL = 'https://lioner.hu/blog/szerzo/adam-kristof';
const README = process.env.README_PATH || 'README.md';
const OUT_DIR = process.env.OUT_DIR || 'dist';

const WEEKDAYS = ['V', 'H', 'K', 'Sze', 'Cs', 'P', 'Szo']; // GraphQL: 0 = vasárnap
const WEEKDAY_NAMES = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];

async function fetchCalendar() {
    const year = new Date().getUTCFullYear();
    const query = `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
            year: contributionsCollection(from: $from, to: $to) {
                contributionCalendar {
                    totalContributions
                    weeks { contributionDays { date contributionCount weekday } }
                }
            }
            last: contributionsCollection {
                contributionCalendar {
                    totalContributions
                    weeks { contributionDays { date contributionCount weekday contributionLevel } }
                }
            }
        }
    }`;
    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': USER },
        body: JSON.stringify({ query, variables: { login: USER, from: `${year}-01-01T00:00:00Z`, to: new Date().toISOString() } }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    const cal = json.data.user.year.contributionCalendar;
    const last = json.data.user.last.contributionCalendar;
    return {
        year, total: cal.totalContributions, days: cal.weeks.flatMap(w => w.contributionDays),
        lastYear: { total: last.totalContributions, weeks: last.weeks },
    };
}

function stats({ year, total, days }) {
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const past = days.filter(d => d.date <= today && d.date >= `${year}-01-01`);

    const thisMonth = past.filter(d => d.date.startsWith(month)).reduce((s, d) => s + d.contributionCount, 0);
    const activeDays = past.filter(d => d.contributionCount > 0).length;

    let longest = 0, run = 0;
    for (const d of past) {
        run = d.contributionCount > 0 ? run + 1 : 0;
        longest = Math.max(longest, run);
    }
    // A mai nap még tarthat, ezért ha ma 0, a tegnapig tartó sorozat számít.
    let current = 0;
    const rev = [...past].reverse();
    const start = rev[0] && rev[0].contributionCount === 0 ? 1 : 0;
    for (const d of rev.slice(start)) {
        if (d.contributionCount === 0) break;
        current++;
    }

    const byWeekday = Array(7).fill(0);
    for (const d of past) byWeekday[d.weekday] += d.contributionCount;
    const busiest = byWeekday.indexOf(Math.max(...byWeekday));

    return { year, total, thisMonth, activeDays, dayCount: past.length, longest, current, byWeekday, busiest, today };
}

async function fetchPosts() {
    const html = await (await fetch(BLOG_URL, { headers: { 'User-Agent': USER } })).text();
    const cards = [...html.matchAll(/<a href="(https:\/\/lioner\.hu\/blog\/[^"]+)" class="blog-card[^"]*">([\s\S]*?)<\/a>/g)];
    return cards
        .map(([, url, body]) => {
            const title = body.match(/blog-title">([^<]+)</)?.[1]?.trim();
            const date = body.match(/(\d{4}\. [a-zá-ű]+ \d{1,2}\.)/i)?.[1];
            return title ? { url, title: decodeEntities(title), date } : null;
        })
        .filter(Boolean);
}

function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = n => n.toLocaleString('hu-HU').replace(/ /g, ' ');
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function terminalSvg(st, latest) {
    const W = 760, H = 300;
    const mono = "font-family='ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'";
    const rows = [
        [`hozzájárulás ${st.year}-ban`, num(st.total)],
        ['ebben a hónapban', num(st.thisMonth)],
        ['aktív napok', `${st.activeDays} / ${st.dayCount}`],
        ['leghosszabb sorozat', `${st.longest} nap`],
        ['jelenlegi sorozat', `${st.current} nap`],
        ['legaktívabb nap', WEEKDAY_NAMES[st.busiest]],
    ];

    let y = 92;
    const lines = rows.map(([k, v]) => {
        const line = `<text x='28' y='${y}' ${mono} font-size='15' fill='#8b949e'>›</text>`
            + `<text x='46' y='${y}' ${mono} font-size='15' fill='#c9d1d9'>${esc(k)}</text>`
            + `<text x='330' y='${y}' ${mono} font-size='15' fill='#ff6b5b' text-anchor='end' font-weight='600'>${esc(v)}</text>`;
        y += 26;
        return line;
    }).join('');

    // Hét napjai szerinti oszlopdiagram, hétfővel kezdve.
    const order = [1, 2, 3, 4, 5, 6, 0];
    const max = Math.max(...st.byWeekday, 1);
    const chartX = 400, chartBottom = 232, chartH = 140, barW = 34, gap = 14;
    const bars = order.map((wd, i) => {
        const h = Math.max(3, Math.round((st.byWeekday[wd] / max) * chartH));
        const x = chartX + i * (barW + gap);
        const fill = wd === st.busiest ? '#ff6b5b' : '#30363d';
        return `<rect x='${x}' y='${chartBottom - h}' width='${barW}' height='${h}' rx='4' fill='${fill}'>`
            + `<title>${WEEKDAY_NAMES[wd]}: ${num(st.byWeekday[wd])}</title></rect>`
            + `<text x='${x + barW / 2}' y='${chartBottom + 18}' ${mono} font-size='12' fill='#8b949e' text-anchor='middle'>${WEEKDAYS[wd]}</text>`;
    }).join('');

    const post = latest ? `<text x='28' y='${H - 30}' ${mono} font-size='13' fill='#8b949e'>legutóbbi cikk: <tspan fill='#c9d1d9'>${esc(cut(latest.title, 62))}</tspan></text>` : '';

    return `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}' role='img' aria-label='Ádám Kristóf GitHub-aktivitása'>
<rect width='${W}' height='${H}' rx='12' fill='#0d1117' stroke='#30363d'/>
<circle cx='24' cy='22' r='6' fill='#ff5f56'/><circle cx='44' cy='22' r='6' fill='#ffbd2e'/><circle cx='64' cy='22' r='6' fill='#27c93f'/>
<text x='${W / 2}' y='27' ${mono} font-size='12' fill='#8b949e' text-anchor='middle'>kristof@lioner: ~</text>
<text x='28' y='60' ${mono} font-size='15' fill='#7ee787'>kristof@lioner<tspan fill='#c9d1d9'>:</tspan><tspan fill='#79c0ff'>~</tspan><tspan fill='#c9d1d9'>$ ./status.sh --ev ${st.year}</tspan></text>
${lines}
<text x='${chartX}' y='76' ${mono} font-size='12' fill='#8b949e'>${st.year}, a hét napjai szerint</text>
${bars}
${post}
<text x='${W - 28}' y='${H - 12}' ${mono} font-size='11' fill='#484f58' text-anchor='end'>frissítve: ${st.today} · GitHub Actions</text>
</svg>
`;
}


// Az elmúlt egy év naptára az adamkristof.hu színeivel (papír háttér, téglavörös fokozatok).
const MONTHS = ['jan', 'febr', 'márc', 'ápr', 'máj', 'jún', 'júl', 'aug', 'szept', 'okt', 'nov', 'dec'];
const LEVEL_FILL = {
    NONE: '#e4e0d8', FIRST_QUARTILE: '#ecc3b6', SECOND_QUARTILE: '#dc917b',
    THIRD_QUARTILE: '#c9634a', FOURTH_QUARTILE: '#b8432b',
};

function calendarSvg({ total, weeks }) {
    const cell = 11, step = 14, left = 34, top = 40;
    const W = left + weeks.length * step + 4, H = top + 7 * step + 34;
    const font = "font-family='ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'";
    const cells = [], months = [];
    let lastMonth = -1;
    weeks.forEach((w, x) => {
        const first = w.contributionDays[0];
        const m = Number(first.date.slice(5, 7)) - 1;
        if (m !== lastMonth && Number(first.date.slice(8, 10)) <= 7) {
            if (x < weeks.length - 2) months.push(`<text x='${left + x * step}' y='${top - 10}' ${font} font-size='11' fill='#6f6a62'>${MONTHS[m]}</text>`);
            lastMonth = m;
        }
        for (const d of w.contributionDays) {
            cells.push(`<rect x='${left + x * step}' y='${top + d.weekday * step}' width='${cell}' height='${cell}' rx='2' fill='${LEVEL_FILL[d.contributionLevel] || LEVEL_FILL.NONE}'><title>${d.date}: ${d.contributionCount}</title></rect>`);
        }
    });
    const dayLabels = [[1, 'H'], [3, 'Sze'], [5, 'P']]
        .map(([wd, t]) => `<text x='0' y='${top + wd * step + 9}' ${font} font-size='10' fill='#6f6a62'>${t}</text>`).join('');
    const legendX = W - 4 - 5 * step - 62;
    const legend = `<text x='${legendX - 8}' y='${H - 8}' ${font} font-size='10' fill='#6f6a62' text-anchor='end'>kevesebb</text>`
        + Object.values(LEVEL_FILL).map((f, i) => `<rect x='${legendX + i * step}' y='${H - 17}' width='${cell}' height='${cell}' rx='2' fill='${f}'/>`).join('')
        + `<text x='${legendX + 5 * step + 4}' y='${H - 8}' ${font} font-size='10' fill='#6f6a62'>több</text>`;
    return `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}' role='img' aria-label='Ádám Kristóf GitHub-hozzájárulásai az elmúlt egy évben: ${num(total)}'>
<text x='0' y='14' ${font} font-size='13' fill='#121212' font-weight='600'>${num(total)} hozzájárulás az elmúlt egy évben</text>
${months.join('')}
${dayLabels}
${cells.join('')}
${legend}
</svg>
`;
}

async function updateReadme(posts) {
    const readme = await readFile(README, 'utf8');
    const list = posts.slice(0, 5).map(p => `- [${p.title}](${p.url})${p.date ? ` · ${p.date}` : ''}`).join('\n');
    const next = readme.replace(/(<!-- BLOG:START -->)[\s\S]*?(<!-- BLOG:END -->)/, `$1\n${list}\n$2`);
    if (next !== readme) await writeFile(README, next);
}

const [calendar, posts] = await Promise.all([fetchCalendar(), fetchPosts().catch(() => [])]);
const st = stats(calendar);
await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/kristof-terminal.svg`, terminalSvg(st, posts[0]));
await writeFile(`${OUT_DIR}/kristof-calendar.svg`, calendarSvg(calendar.lastYear));
if (posts.length) await updateReadme(posts);
console.log(JSON.stringify({ ...st, lastYear: calendar.lastYear.total, posts: posts.length }));
