import {chorusSettings,rhythmicDelaySettings} from '@denaudio/den/delay-settings';
import {diagnosticInstrumentParameters,bassConfig,bassParameters,percussionConfig,percussionParameters,padConfig,padParameters} from '@denaudio/den/instrument';
// The diagnostic values retain the previous candidate's actual native defaults.
export const engineConfig = {mode:'poly',capacity:4,heldCapacity:32,waveform:'sine'};
export const instrumentInitial = {...diagnosticInstrumentParameters,gain:.05,ampAttack:.01,ampDecay:0,ampSustain:1,ampRelease:.2,cutoff:1000,resonance:.5,pitchEnvelopeDepth:0,filterEnvelopeDepth:0,lfoAmpDepth:0,lfoPitchDepth:0,lfoFilterDepth:0};
export const instrumentCandidates = {
  diagnostic:{label:'Diagnostic',config:engineConfig,parameters:instrumentInitial,notes:[60,64,67,72],chord:[60,64,67,72],description:'Poly · 4 sine voices. Hold individual notes or the chord.',holdLabel:'Hold C major chord · 4 voices'},
  bass:{label:'Bass',config:bassConfig,parameters:bassParameters,notes:[36,40,43,48],chord:[36],description:'Mono · last-held note, legato. Overlap keys to hear the note change.',holdLabel:'Hold C2 · mono'},
  percussion:{label:'Percussion',config:percussionConfig,parameters:percussionParameters,notes:[36,38,43,48],chord:[36],description:'Mono · retriggered tonal hits. Release and press again for another hit.',holdLabel:'Trigger C2 · mono'},
  pad:{label:'Pad',config:padConfig,parameters:padParameters,notes:[48,55,60,64],chord:[48,55,60,64],description:'Poly · 4 saw voices. Hold for the slow rise; release leaves a long tail.',holdLabel:'Hold C major chord · 4 voices'},
};
export const delayInitial = {timeLeft:.125,timeRight:.1875,feedback:.25,mix:.35};
// Raw instrument gains are untouched. This shared output stage has no normalization.
// The new saw/modulated sources require their own measured matrix, not the former
// diagnostic-only 0.8 bound at Master=2. See the audition headroom evidence.
export const masterDefault=1, masterMaximum=1, feedbackMaximum=.5;
export const delayCandidates={diagnostic:{config:{maxDelaySeconds:1,tone:'lowpass'},parameters:delayInitial},chorus:chorusSettings,rhythmic:rhythmicDelaySettings};
