"""Static raw input/output waveforms on the same time and amplitude scale."""
import hashlib
import json
import pathlib
import struct
import sys
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

folder = pathlib.Path(sys.argv[1])
manifest = json.loads((folder / 'manifest.json').read_text())

def samples(path):
    data = path.read_bytes()
    offset = 12
    while offset + 8 <= len(data):
        tag, size = struct.unpack_from('<4sI', data, offset)
        offset += 8
        if tag == b'data':
            return np.frombuffer(data[offset:offset + size], dtype='<f4').reshape(-1, 2)
        offset += size + size % 2
    raise ValueError('Missing WAV data')

for case in manifest['cases']:
    fig, axes = plt.subplots(4, 1, figsize=(11, 7), sharex=True, sharey=True)
    for kind, base in [('input', 0), ('raw', 2)]:
        audio = samples(folder / case[kind]['file'])
        for channel in range(2):
            ax = axes[base + channel]
            # Min/max envelopes preserve short peaks; no loudness normalization.
            blocks = audio[:, channel].reshape(-1, 128)
            time = np.arange(len(blocks)) * 128 / manifest['sampleRate']
            ax.fill_between(time, blocks.min(axis=1), blocks.max(axis=1), color='#2454a0', linewidth=0.4)
            ax.set_ylabel(f'{kind} {"LR"[channel]}')
            ax.set_ylim(-0.5, 0.5)
            ax.grid(alpha=0.2)
            for event in case['events']:
                ax.axvline(event['sample'] / manifest['sampleRate'], color='#b45020', alpha=0.4, linewidth=0.6)
    axes[-1].set_xlabel('Seconds — identical time and amplitude scales; raw float audio')
    axes[-1].set_xlim(0, manifest['durationSeconds'])
    fig.suptitle(f'CANDIDATE / {case["id"]} / 48 kHz — not approved golden')
    fig.tight_layout()
    file = folder / f'{case["id"]}-waveform.png'
    fig.savefig(file, dpi=140)
    plt.close(fig)
    case['waveform'] = {'file': file.name, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'bucketSamples': 128, 'amplitudeRange': [-0.5, 0.5]}
manifest['plotter'] = {'matplotlib': matplotlib.__version__, 'numpy': np.__version__}
(folder / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
