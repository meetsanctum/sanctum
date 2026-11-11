// Draws SVG files as PNGs with AppKit, as macOS draws them:
// swift rasterise.swift <in.svg> <width> <height> <out.png> [...]
import AppKit

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count % 4 == 0, !arguments.isEmpty else {
  FileHandle.standardError.write("usage: rasterise.swift <in.svg> <width> <height> <out.png> ...\n".data(using: .utf8)!)
  exit(2)
}

for index in stride(from: 0, to: arguments.count, by: 4) {
  let (input, output) = (arguments[index], arguments[index + 3])
  guard let image = NSImage(contentsOfFile: input),
    let width = Int(arguments[index + 1]), let height = Int(arguments[index + 2]),
    let bitmap = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
      bytesPerRow: 0, bitsPerPixel: 0)
  else {
    FileHandle.standardError.write("cannot draw \(input)\n".data(using: .utf8)!)
    exit(1)
  }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
  image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
  NSGraphicsContext.restoreGraphicsState()
  try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
}
