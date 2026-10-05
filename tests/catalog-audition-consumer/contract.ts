import { compile } from '@unworklet/core';
import {
  glassDyad, fmModalHit, grainCloud, shapedEcho, musicalMaterialsStatus,
  glassDyadParameters, glassDyadBrightParameters, glassDyadConstruction, makeGlassDyadTable,
  fmModalHitParameters, fmModalHitBellParameters, fmModalHitModes,
  grainCloudParameters, grainCloudReverseParameters, grainCloudConstruction, makeGrainCloudSample,
  shapedEchoParameters, shapedEchoDarkParameters,
} from '@denaudio/den/musical-examples';
const candidate: 'CANDIDATE' = musicalMaterialsStatus;
const assets: Float32Array[] = [makeGlassDyadTable(), makeGrainCloudSample()];
const settings: Readonly<Record<string, number>>[] = [glassDyadParameters, glassDyadBrightParameters,
  fmModalHitParameters, fmModalHitBellParameters, grainCloudParameters, grainCloudReverseParameters,
  shapedEchoParameters, shapedEchoDarkParameters];
for (const processor of [glassDyad, fmModalHit, grainCloud, shapedEcho]) void compile(processor, { sampleRate: 48000 });
void [candidate, assets, settings, glassDyadConstruction, grainCloudConstruction, fmModalHitModes];
