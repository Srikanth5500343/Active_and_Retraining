import json, sys, os, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

base = 'C:/Users/AasrithaSravaniBhami/.claude/projects/h--dark-mobile/'
files = [
    ('Apr13', '451dced9-5d33-4000-a347-d36a36b8d6e0.jsonl'),
    ('Apr14', '0866f875-0f82-4244-9bda-f9e50ee72b81.jsonl'),
    ('Apr14', 'bc0f35ac-fe4f-40ed-910d-1af485d7d57c.jsonl'),
    ('Apr14', 'c0c7eed7-4be0-4389-861f-08db2941aa08.jsonl'),
    ('Apr14', 'c45b0f1a-85d3-47af-bad5-8aaef5467185.jsonl'),
    ('Apr14', 'c7b56694-1598-40da-a8ec-b0ac4430b147.jsonl'),
    ('Apr15-16', '4651bf74-6ede-48e3-842d-6563d61f62b0.jsonl'),
    ('Apr16', '67ab6c56-65ca-4bb7-9052-e1dc47f16caa.jsonl'),
    ('Apr17', '37fea41a-2afd-46f5-b2a5-78b513a6c21b.jsonl'),
    ('Apr17', 'e122716f-2c18-49ba-97b4-1de8081fa8ba.jsonl'),
    ('Apr17', 'e6662d52-8f16-4447-8b5d-383b7f7e0caf.jsonl'),
    ('Apr20', '43b89aa0-9f0a-4c23-9642-167ddd73d74e.jsonl'),
    ('Apr20', '317d5e28-060a-4281-a06c-0167bd35caf9.jsonl'),
]

target = sys.argv[1] if len(sys.argv) > 1 else None
max_per = int(sys.argv[2]) if len(sys.argv) > 2 else 200

for day, f in files:
    if target and target not in f:
        continue
    path = base + f
    if not os.path.exists(path):
        continue
    print('=' * 70)
    print(f'FILE: {day} - {f}')
    print('=' * 70)
    user_count = 0
    asst_preview_count = 0
    with open(path, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            try:
                obj = json.loads(line)
            except:
                continue
            t = obj.get('type')
            if t == 'user':
                msg = obj.get('message', {})
                content = msg.get('content', '')
                if isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get('type') == 'text':
                            text = c.get('text', '')
                            if text and not text.startswith('<') and not text.startswith('[Request'):
                                print('U:', text[:400].replace('\n', ' | '))
                                user_count += 1
                elif isinstance(content, str):
                    if content and not content.startswith('<') and not content.startswith('[Request') and '"tool_use_id"' not in content and 'tool_result' not in content[:50]:
                        print('U:', content[:400].replace('\n', ' | '))
                        user_count += 1
            elif t == 'assistant':
                msg = obj.get('message', {})
                content = msg.get('content', '')
                if isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get('type') == 'text':
                            text = c.get('text', '')
                            if text and len(text) > 20 and asst_preview_count < max_per:
                                # Only print first short line (topic summary)
                                first = text.split('\n')[0][:200]
                                print('A:', first)
                                asst_preview_count += 1
                                break
            if user_count > max_per:
                break
    print(f'\n[Total users: {user_count}, asst previews: {asst_preview_count}]\n')
