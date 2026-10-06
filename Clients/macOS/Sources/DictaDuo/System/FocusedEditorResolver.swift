import ApplicationServices
import Foundation

/// Follow only the focused node's declared editing context, never search other
/// fields in the window. A web container alone is not evidence of editability.
struct FocusedEditorResolver<Element> {
    enum Resolution {
        case editor(Element)
        case noneditable
        case blocked
    }

    let eligibility: (Element) -> InsertionFieldPolicy.Eligibility?
    let editableAncestor: (Element) -> Element?
    let parent: (Element) -> Element?
    let sameElement: (Element, Element) -> Bool
    let sameOwner: (Element, Element) -> Bool

    func resolve(_ focused: Element, maximumDepth: Int = 8) -> Resolution {
        switch eligibility(focused) {
        case .editable: return .editor(focused)
        case .protected, .unverified, nil: return .blocked
        case .notEditable: break
        }
        guard let ancestor = editableAncestor(focused), !sameElement(focused, ancestor),
              sameOwner(focused, ancestor) else { return .noneditable }
        var current = focused
        var visited = [focused]
        for _ in 0..<maximumDepth {
            guard let next = parent(current), sameOwner(focused, next),
                  !visited.contains(where: { sameElement($0, next) }) else { return .blocked }
            visited.append(next)
            let state = eligibility(next)
            if state == .protected || state == .unverified || state == nil { return .blocked }
            if sameElement(next, ancestor) {
                return state == .editable ? .editor(next) : .noneditable
            }
            current = next
        }
        return .blocked
    }
}
