import AppKit

@MainActor
enum MomoAvatarImageCache {
    private static let cache = NSCache<NSString, NSImage>()

    static func image(atPath path: String) -> NSImage? {
        let key = path as NSString
        if let cached = cache.object(forKey: key) {
            return cached
        }
        guard let image = NSImage(contentsOfFile: path) else {
            return nil
        }
        cache.setObject(image, forKey: key)
        return image
    }

    static func store(_ image: NSImage, atPath path: String) {
        cache.setObject(image, forKey: path as NSString)
    }
}
