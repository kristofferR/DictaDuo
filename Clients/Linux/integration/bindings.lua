-- Kris selected Menu for DictaDuo, replacing its Voxtype toggle binding.
-- Remove the existing Menu binding once, then add both press and release actions.
hl.unbind("Menu")
-- Compositor events preserve press/release ordering without racing CLI processes.
o.bind("Menu", "DictaDuo: start dictation", hl.dsp.event("dictaduo:start"))
o.bind("Menu", "DictaDuo: stop dictation", hl.dsp.event("dictaduo:stop"), { release = true, ignore_mods = true })
o.bind("SUPER + Menu", "DictaDuo: cancel dictation", hl.dsp.event("dictaduo:cancel"))
o.bind("SUPER + SHIFT + Menu", "DictaDuo: copy last result", hl.dsp.event("dictaduo:copy"))
