import os
import math
import struct
import wave

AUDIO_DIR = os.path.join(os.path.dirname(__file__), 'static', 'audio')
os.makedirs(AUDIO_DIR, exist_ok=True)

def create_tone_wav(filepath, duration_sec, freq_list):
    sample_rate = 44100
    num_samples = int(sample_rate * duration_sec)
    
    with wave.open(filepath, 'w') as wav_file:
        wav_file.setnchannels(1) # Mono
        wav_file.setsampwidth(2) # 16-bit
        wav_file.setframerate(sample_rate)
        
        frames = bytearray()
        for i in range(num_samples):
            t = float(i) / sample_rate
            # Determine current tone
            sub_index = int(t * len(freq_list) / duration_sec)
            sub_index = min(sub_index, len(freq_list) - 1)
            freq = freq_list[sub_index]
            
            # Envelope (fade in/out)
            fade = 1.0
            if t < 0.05:
                fade = t / 0.05
            elif t > duration_sec - 0.05:
                fade = (duration_sec - t) / 0.05
                
            sample_val = int(32767.0 * 0.3 * fade * math.sin(2.0 * math.pi * freq * t))
            frames.extend(struct.pack('<h', sample_val))
            
        wav_file.writeframes(frames)
    print(f"Generated audio asset: {filepath} ({duration_sec}s)")

# Generate required audio files
audio_specs = {
    'welcome.mp3': (4.0, [440, 554.37, 659.25, 880]),     # A Major Arpeggio Welcome
    'count_3.mp3': (3.0, [880, 880, 1046.5]),            # 3 Countdown Ticks
    'count_5.mp3': (5.0, [600, 700, 800, 900, 1000]),     # 5 Countdown Ticks
    'switch_props.mp3': (4.5, [523.25, 659.25, 523.25]),  # Switch Props Chime
    'get_ready_2.mp3': (2.0, [659.25, 783.99]),          # Get Ready 2 Chime
    'get_ready_3.mp3': (2.0, [783.99, 880.00]),          # Get Ready 3 Chime
    'complete.mp3': (4.0, [523.25, 659.25, 783.99, 1046.5, 1318.5]), # Fanfare
    'cancelled.mp3': (2.5, [440, 349.23, 293.66])        # Cancelled Descending Tone
}

def generate_all():
    for filename, (duration, freqs) in audio_specs.items():
        filepath = os.path.join(AUDIO_DIR, filename)
        create_tone_wav(filepath, duration, freqs)

if __name__ == '__main__':
    generate_all()
