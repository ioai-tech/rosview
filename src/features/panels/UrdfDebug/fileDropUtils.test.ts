import { describe, expect, it } from 'vitest';
import { pickMeshFiles, pickUrdfFile } from './fileDropUtils';

function mockFile(name: string): File {
  return new File([''], name, { type: 'application/octet-stream' });
}

describe('fileDropUtils', () => {
  it('pickUrdfFile selects urdf or xml', () => {
    const files = [mockFile('mesh.stl'), mockFile('robot.urdf'), mockFile('other.txt')];
    expect(pickUrdfFile(files)?.name).toBe('robot.urdf');
    expect(pickUrdfFile([mockFile('model.xml')])?.name).toBe('model.xml');
    expect(pickUrdfFile([mockFile('readme.txt')])).toBeNull();
  });

  it('pickMeshFiles filters mesh extensions', () => {
    const files = [mockFile('a.stl'), mockFile('b.dae'), mockFile('c.obj'), mockFile('d.urdf')];
    expect(pickMeshFiles(files).map((f) => f.name)).toEqual(['a.stl', 'b.dae', 'c.obj']);
  });
});
