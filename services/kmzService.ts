import JSZip from 'jszip';

interface Layer {
  name: string;
  blob: Blob;
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
}

export const createKmz = async (layers: Layer[]): Promise<Blob> => {
  const zip = new JSZip();

  // Generate KML Content
  let kmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Folder>
    <name>Operators Density Heatmaps</name>
    <open>1</open>
`;

  layers.forEach((layer) => {
    const filename = `${layer.name.replace(/\s+/g, '_')}.png`;
    kmlContent += `
    <GroundOverlay>
      <name>${layer.name}</name>
      <Icon>
        <href>${filename}</href>
      </Icon>
      <LatLonBox>
        <north>${layer.bounds.north}</north>
        <south>${layer.bounds.south}</south>
        <east>${layer.bounds.east}</east>
        <west>${layer.bounds.west}</west>
      </LatLonBox>
    </GroundOverlay>
`;
    // Add image to zip
    zip.file(filename, layer.blob);
  });

  kmlContent += `
  </Folder>
</kml>`;

  zip.file("doc.kml", kmlContent);

  return await zip.generateAsync({ type: "blob" });
};