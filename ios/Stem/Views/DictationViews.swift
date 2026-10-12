import SwiftUI

/// Settings → Dictation: the language, and how the mic works.
struct DictationSettingsSection: View {
    @AppStorage(PhoneDictation.localeKey) private var locale = ""
    @State private var dictation = PhoneDictation()

    var body: some View {
        Section {
            NavigationLink {
                DictationLanguageList(dictation: dictation)
            } label: {
                LabeledContent("Language", value: languageName(locale, in: dictation.languages))
            }
        } header: {
            Text("Dictation")
        } footer: {
            Text("Tap the mic in the message field to dictate, tap again to stop. Long-press it to switch language. A new language downloads once, the first time you dictate in it; after that it works offline, on this iPhone only.")
        }
        .task { await dictation.loadLanguages() }
    }
}

/// Every language dictation knows, the ones already on the phone first.
struct DictationLanguageList: View {
    let dictation: PhoneDictation
    @AppStorage(PhoneDictation.localeKey) private var locale = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let onPhone = dictation.languages.filter(\.installed)
        let rest = dictation.languages.filter { !$0.installed }
        List {
            Section {
                row(id: "", name: "Phone language")
                ForEach(onPhone, id: \.id) { row(id: $0.id, name: $0.name) }
            } header: {
                Text("On this iPhone")
            }
            if !rest.isEmpty {
                Section {
                    ForEach(rest, id: \.id) { row(id: $0.id, name: $0.name) }
                } header: {
                    Text("Downloads on first use")
                }
            }
        }
        .overlay { if dictation.languages.isEmpty { ProgressView() } }
        .navigationTitle("Dictation language")
        .navigationBarTitleDisplayMode(.inline)
        .task { await dictation.loadLanguages() }
    }

    private func row(id: String, name: String) -> some View {
        Button {
            locale = id
            dismiss()
        } label: {
            HStack {
                Text(name)
                Spacer()
                if locale == id { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
        }
        .tint(.primary)
    }
}

/// Shown on the first tap of the mic: how it works, and the language to use.
struct DictationIntroSheet: View {
    let dictation: PhoneDictation
    let onStart: () -> Void
    @AppStorage(PhoneDictation.localeKey) private var locale = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    tip("mic", "Tap the mic to dictate, tap again to stop. Words appear as you speak.")
                    tip("hand.tap", "Long-press the mic to switch language.")
                    tip("arrow.down.circle", "A new language downloads once, the first time you use it. After that it works offline.")
                    tip("lock", "Speech is turned into text on this iPhone. Nothing is sent until you press Send.")
                }
                Section {
                    NavigationLink {
                        DictationLanguageList(dictation: dictation)
                    } label: {
                        LabeledContent("Language", value: languageName(locale, in: dictation.languages))
                    }
                } footer: {
                    Text("You can change it later in Settings → Dictation.")
                }
            }
            .navigationTitle("Dictation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Not now") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    dismiss()
                    onStart()
                } label: {
                    Text("Start dictating").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding()
            }
        }
        .presentationDetents([.large])
    }

    private func tip(_ symbol: String, _ text: String) -> some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: symbol).foregroundStyle(.tint)
        }
    }
}

private func languageName(_ id: String, in languages: [DictationLanguage]) -> String {
    if id.isEmpty { return "Phone language" }
    return languages.first { $0.id == id }?.name ?? Locale.current.localizedString(forIdentifier: id) ?? id
}
