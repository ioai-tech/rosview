const URDF_EXT = /\.(urdf|xml)$/i;
const MESH_EXT = /\.(stl|dae|obj)$/i;

export function pickUrdfFile(files: File[]): File | null {
  return files.find((file) => URDF_EXT.test(file.name)) ?? null;
}

export function pickMeshFiles(files: File[]): File[] {
  return files.filter((file) => MESH_EXT.test(file.name));
}

export function filesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  return Array.from(dataTransfer.files);
}
