# Fake Clockify API for tools/shoot.sh: GET user/projects/tags/time-entries, PATCH stop, POST start.
import json, sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

now = datetime.now(timezone.utc)
iso = lambda d: d.strftime('%Y-%m-%dT%H:%M:%SZ')
projects = [
    {'id': 'p1', 'name': 'Falcon Website', 'clientName': 'Falcon', 'color': '#e5534b', 'billable': True},
    {'id': 'p2', 'name': 'Internal', 'clientName': '', 'color': '#57ab5a', 'billable': False},
    {'id': 'p3', 'name': 'Kunde Müller', 'clientName': 'Müller GmbH', 'color': '#539bf5', 'billable': True},
]
tags = [{'id': 't1', 'name': 'Meeting'}, {'id': 't2', 'name': 'Code Review'}]
def entry(desc, pid, minutes_ago, running=False, tagIds=()):
    s = now - timedelta(minutes=minutes_ago)
    p = next(x for x in projects if x['id'] == pid)
    return {'description': desc, 'projectId': pid, 'tagIds': list(tagIds), 'billable': p['billable'], 'project': p,
            'tags': [t for t in tags if t['id'] in tagIds],
            'timeInterval': {'start': iso(s), 'end': None if running else iso(s + timedelta(minutes=30))}}
entries = [
    entry('API refactoring', 'p1', 83, running=True),
    entry('Daily standup', 'p2', 60 * 5, tagIds=['t1']),
    entry('Review PR #142', 'p1', 60 * 26, tagIds=['t2']),
    entry('Angebot schreiben', 'p3', 60 * 50),
    entry('Daily standup', 'p2', 60 * 29, tagIds=['t1']),
    entry('Onboarding docs', 'p2', 60 * 24 * 9),
]
log = open(__import__("os").devnull, "w")
class H(BaseHTTPRequestHandler):
    def send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        p = self.path.removeprefix('/api/v1')
        if p.startswith('/user'): return self.send({'id': 'u1', 'name': 'Alex Example', 'activeWorkspace': 'w1'})
        if '/projects' in p: return self.send(projects)
        if '/tags' in p: return self.send(tags)
        if 'in-progress=true' in p: return self.send([e for e in entries if not e['timeInterval']['end']])
        if '/time-entries' in p: return self.send(entries)
        self.send_error(404)
    def do_PATCH(self):
        body = self.rfile.read(int(self.headers['Content-Length'])).decode()
        log.write(f'PATCH {self.path} {body}\n'); log.flush()
        for e in entries:
            if not e['timeInterval']['end']: e['timeInterval']['end'] = json.loads(body)['end']
        self.send({})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])).decode())
        log.write(f'POST {self.path} {json.dumps(body)}\n'); log.flush()
        p = next((x for x in projects if x['id'] == body.get('projectId')), projects[1])
        entries.insert(0, {**body, 'project': p, 'tags': [t for t in tags if t['id'] in body.get('tagIds', [])], 'timeInterval': {'start': body['start'], 'end': None}})
        self.send({})
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 8765), H).serve_forever()
