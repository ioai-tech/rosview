import { describe, expect, it } from 'vitest';
import { imageFoxgloveAdapter } from './foxgloveAdapter';

describe('imageFoxgloveAdapter', () => {
  it('round-trips annotation and scene mesh topics', () => {
    const decoded = imageFoxgloveAdapter.fromConfig({
      topic: '/warehouse/front_camera/image',
      annotationTopic: '/warehouse/front_camera/annotations',
      meshTopic: '/warehouse/safety_zones',
    });

    const exported = imageFoxgloveAdapter.toConfig({
      config: decoded.config,
      extras: decoded.extras,
      title: decoded.title,
    });

    expect(exported.annotationTopic).toBe('/warehouse/front_camera/annotations');
    expect(exported.meshTopic).toBe('/warehouse/safety_zones');
  });
});
