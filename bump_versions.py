import json
import glob
import os

files = glob.glob('/home/aryee/aery/ai_agent/aery/packages/*/package.json')
for file in files:
    with open(file, 'r') as f:
        data = json.load(f)
    if data.get('version') == '0.2.10':
        data['version'] = '0.3.0'
        with open(file, 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
print(f"Updated {len(files)} files.")
