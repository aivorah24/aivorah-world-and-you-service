"""Rebuild data/gk-events.json from the "Important Days of India & World" GK book.

Usage:
    pdftotext -enc UTF-8 Important_Days_India_GK_Expanded.pdf gk.txt
    python current-affairs/scripts/build-gk-events.py gk.txt current-affairs/data/gk-events.json

Book structure (per date):
    <emoji> January 15 — Indian Army Day <flag> | Pongal <flag>
    <flag> Indian Army Day                 (sub-heading, only when >1 event)
    • What is it? ... • Why is it special? ... • Did You Know? ...
Month chapters start with "FEBRUARY (29 Days) -- ..." plus an intro paragraph.
"""
import json
import re
import sys

MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
          'August', 'September', 'October', 'November', 'December']
MONTH_RE = '|'.join(MONTHS)
DATE_HDR = re.compile(rf'^({MONTH_RE}) (\d{{1,2}}) [—–-]+ (.+)$')
CHAPTER = re.compile(r'^(?:' + '|'.join(m.upper() for m in MONTHS) + r') \(\d+ Days\)')

LABELS = [  # (prefix, field) — checked in order
    ('What is it?', 'description'),
    ('Why is it special?', 'why_special'),
    ('Why is it important?', 'why_special'),
    ('How is it celebrated?', 'how_celebrated'),
    ('How is it observed?', 'how_celebrated'),
    ('How is it marked?', 'how_celebrated'),
    ('The Story:', 'story'),
    ('Did You Know?', 'facts'),
    ('Famous Quotes:', 'quote'),
    ('Famous Quote:', 'quote'),
    ('Why 26 January?', 'why_special'),
]
END_OF_DAYS = re.compile(r'^FINAL SUMMARY\b')

# Emoji / symbol characters the PDF uses as decorations.
EMOJI = re.compile(
    '[\ud800-\udfff'            # lone surrogates (pdftotext writes astral chars as CESU-8)
    '\U0001F000-\U0001FFFF'     # pictographs, flags (regional indicators)
    '☀-➿'             # misc symbols & dingbats (⭐ ✅ ...)
    '⬀-⯿'             # ⭐ etc.
    '︀-️‍⃣'  # variation selectors, ZWJ, keycap
    '-'             # private use
    '�]'                   # replacement char
)


def clean(s):
    s = EMOJI.sub('', s)
    s = s.replace(' -- ', ' — ')
    return re.sub(r'\s+', ' ', s).strip()


def norm_name(s):
    return re.sub(r'[^a-z0-9]+', '', s.lower())


def strip_shout(name):
    """Drop decorative notes like "(THE MOST IMPORTANT DAY!)"."""
    return re.sub(r'\s*\((?:[^()a-z]+|[^()]*!)\)\s*$', '', name).strip()


def subheading_name(text, names):
    """If `text` is the sub-heading of one of the date's events, return the
    event name. Sub-headings may add a bracketed note to the header's name:
    "Shaheed Diwas (Martyrs' Day)" is kept, "(THE MOST IMPORTANT DAY!)" dropped."""
    for n in names:
        if norm_name(text) == norm_name(n):
            return n
        rest = text[len(n):].strip() if text.startswith(n) else ''
        if re.fullmatch(r'\([^()]+\)', rest):
            note = rest[1:-1]
            return n if (note.isupper() or note.endswith('!')) else text
    return None


def parse_fields(text):
    """Split an event's text on bullets into the JSON fields."""
    """Split an event's text on bullets into the JSON fields.

    Bullets without one of LABELS ("• Military power — tanks...", "• How does
    Braille work? ...") are sub-points of the bullet above them, so they are
    added to that field; under "Did You Know?" each one is its own fact."""
    ev = {'description': '', 'why_special': '', 'how_celebrated': '', 'story': '', 'facts': [], 'quote': ''}
    field = 'description'
    for seg in text.split('•'):
        seg = clean(seg)
        if not seg:
            continue
        body = seg
        for prefix, f in LABELS:
            if seg.startswith(prefix):
                field, body = f, seg[len(prefix):].strip()
                labelled = True
                break
        else:
            labelled = False
        if not body:
            continue  # label whose items follow as sub-bullets
        if field == 'facts':
            ev['facts'].append(body)
        elif field == 'quote' and ev['quote'] and not labelled:
            ev['quote'] += ' ' + body
        else:
            prev = ev[field]
            # list items ("• Military power — ...") have no full stop; keep them apart
            sep = ' ' if (not prev or labelled or re.search(r'[.!?:"”)]$', prev)) else '; '
            ev[field] = (prev + sep + body).strip()
    return ev


MONTH_ABBR = {m[:3].lower(): i + 1 for i, m in enumerate(MONTHS)}
# "Same as June 2.", "Same as March 11 — kidney health awareness.",
# "Same as Data Privacy Day (Jan 22) — ...", "Same as June 2. The UN designated ..."
SAME_AS = re.compile(r'^Same as (?:(?P<name>[^(—]+?) \()?(?P<mon>[A-Z][a-z]+)\.? (?P<day>\d{1,2})\)?\.?\s*'
                     r'(?:—\s*(?P<restate>[^.]*\.?)\s*)?(?P<extra>.*)$')


def tokens(name):
    return set(re.findall(r'[a-z]{3,}', re.sub(r'\(alternate\)', '', name.lower()))) - {'day', 'world', 'international', 'national'}


def resolve_same_as(items):
    """The book describes some alternate dates only as "Same as June 2." Fill
    those from the event they point to, so search and quizzes get real text."""
    for e in items:
        m = SAME_AS.match(e['description'])
        if not m:
            continue
        mon = MONTH_ABBR.get(m.group('mon')[:3].lower())
        if not mon:
            continue
        date = f'{mon:02d}-{int(m.group("day")):02d}'
        cands = [x for x in items if x['date'] == date and x is not e]
        if m.group('name'):
            cands = [x for x in cands if tokens(m.group('name')) & tokens(x['event_name'])] or cands
        ref = max(cands, key=lambda x: len(tokens(x['event_name']) & tokens(e['event_name'])), default=None)
        if not ref or not (tokens(ref['event_name']) & tokens(e['event_name'])):
            print(f'WARN unresolved "{e["description"]}" for {e["date"]} {e["event_name"]}', file=sys.stderr)
            continue
        # the "— kidney health awareness" restatement is dropped (the referenced
        # description says it in full); any other sentence the book adds is kept
        own_extra = ' '.join(x for x in [m.group('extra').strip(), e['why_special']] if x)
        e['description'] = ref['description']
        e['why_special'] = (f'Also observed on {MONTHS[mon - 1]} {int(m.group("day"))}. '
                            + ' '.join(x for x in [own_extra, ref['why_special']] if x)).strip()
        for f in ('how_celebrated', 'story', 'quote'):
            e[f] = e[f] or ref[f]
        e['facts'] = e['facts'] or list(ref['facts'])


def main(src, out):
    raw = open(src, 'rb').read().decode('utf-8', errors='surrogatepass')
    lines = raw.replace('\f', '\n').split('\n')

    events = []
    cur_date = None      # (month, day)
    names = []           # event names announced in the current date header
    cur = None           # current event dict (with '_buf')

    def flush():
        nonlocal cur
        if cur is not None:
            events.append(cur)
        cur = None

    cleaned = [clean(l) for l in lines]
    nxt = [''] * len(lines)  # next non-empty cleaned line after each line
    upcoming = ''
    for i in range(len(lines) - 1, -1, -1):
        nxt[i] = upcoming
        if cleaned[i]:
            upcoming = cleaned[i]

    for i, line in enumerate(lines):
        text = cleaned[i]
        if not text:
            continue
        m = DATE_HDR.match(text)
        if m:
            flush()
            month, day = m.group(1), int(m.group(2))
            cur_date = (month, day)
            names = [n.strip() for n in m.group(3).split('|') if n.strip()]
            if len(names) == 1:
                cur = {'event_name': names[0], 'month': month, 'day': day, '_buf': []}
            continue
        if END_OF_DAYS.match(text):
            break
        if CHAPTER.match(text):
            flush()
            cur_date = None  # skip the chapter intro until the next date header
            continue
        if cur_date is None:
            continue
        heading = None
        if not text.startswith('•') and len(names) > 1:
            heading = subheading_name(text, names)
            # Sub-headings may use a longer name than the date header
            # ("Racial Discrimination Day" → "International Day for the
            # Elimination of Racial Discrimination"); they are the only short
            # non-bullet lines directly followed by "• What is it?".
            if not heading and nxt[i].startswith('• What is it?') and len(text) < 120 and not text.endswith('.'):
                heading = strip_shout(text)
        if heading:
            flush()
            cur = {'event_name': heading, 'month': cur_date[0], 'day': cur_date[1], '_buf': []}
            continue
        if cur is None:
            # text after a multi-event header but before its first sub-heading
            print(f'WARN orphan text on {cur_date}: {text[:80]}', file=sys.stderr)
            continue
        cur['_buf'].append(line)
    flush()

    for e in events:
        e['event_name'] = e['event_name'].replace('NonViolence', 'Non-Violence')  # typo in the book

    result = []
    for e in events:
        body = ' '.join(e.pop('_buf'))
        f = parse_fields(body)
        month_num = MONTHS.index(e['month']) + 1
        item = {**f, 'event_name': e['event_name'], 'month': e['month'], 'day': e['day'],
                'date': f'{month_num:02d}-{e["day"]:02d}'}
        result.append(item)

    resolve_same_as(result)
    for item in result:
        parts = [item['event_name'] + '.', item['description'], item['why_special'], item['how_celebrated'],
                 item['story'], ' '.join(item['facts']), item['quote']]
        item['full_text'] = ' '.join(p for p in parts if p)

    with open(out, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
        fh.write('\n')
    print(f'{len(result)} events written to {out}', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
