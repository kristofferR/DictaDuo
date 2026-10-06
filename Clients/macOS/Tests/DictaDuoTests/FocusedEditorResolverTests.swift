import XCTest
@testable import DictaDuo

final class FocusedEditorResolverTests: XCTestCase {
    func testOnlyExplicitlyEditableWebContainersAreEligible() {
        for role in ["AXGroup", "AXWebArea"] {
            XCTAssertEqual(InsertionFieldPolicy.eligibility(role: role, subrole: nil, protectedContent: false, enabled: true), .notEditable)
            XCTAssertEqual(InsertionFieldPolicy.eligibility(role: role, subrole: nil, protectedContent: false, enabled: true, editable: true), .editable)
            XCTAssertEqual(InsertionFieldPolicy.eligibility(role: role, subrole: nil, protectedContent: false, enabled: true, valueSettable: true), .editable)
            XCTAssertEqual(InsertionFieldPolicy.eligibility(role: role, subrole: nil, protectedContent: true, enabled: true, editable: true), .protected)
            XCTAssertEqual(InsertionFieldPolicy.eligibility(role: role, subrole: nil, protectedContent: false, enabled: false, editable: true), .notEditable)
        }
    }

    func testFocusedDescendantResolvesToItsVerifiedEditingAncestor() {
        let resolver = makeResolver(states: [0: .notEditable, 1: .notEditable, 2: .editable], parents: [0: 1, 1: 2])
        guard case .editor(2) = resolver.resolve(0) else { return XCTFail("Expected the declared editing root") }
    }

    func testProtectedUnknownUnrelatedAndCyclicAncestorsCannotBecomeTargets() {
        for state in [InsertionFieldPolicy.Eligibility.protected, .unverified] {
            guard case .blocked = makeResolver(states: [0: .notEditable, 1: state, 2: .editable], parents: [0: 1, 1: 2]).resolve(0)
            else { return XCTFail("An unsafe ancestor must block delivery") }
        }
        guard case .blocked = makeResolver(states: [0: .notEditable, 1: .editable, 2: .editable], parents: [0: 1]).resolve(0)
        else { return XCTFail("An editable sibling is not the declared ancestor") }
        guard case .blocked = makeResolver(states: [0: .notEditable, 1: .notEditable, 2: .editable], parents: [0: 1, 1: 0]).resolve(0)
        else { return XCTFail("Cycles must terminate") }
        guard case .noneditable = makeResolver(states: [0: .notEditable, 2: .editable], parents: [0: 2], sameOwner: false).resolve(0)
        else { return XCTFail("A different process cannot supply the editor") }
    }

    private func makeResolver(states: [Int: InsertionFieldPolicy.Eligibility], parents: [Int: Int], sameOwner: Bool = true) -> FocusedEditorResolver<Int> {
        FocusedEditorResolver(eligibility: { states[$0] }, editableAncestor: { _ in 2 },
                              parent: { parents[$0] }, sameElement: ==, sameOwner: { _, _ in sameOwner })
    }
}
