require 'sketchup.rb'
require 'extensions.rb'

unless file_loaded?(__FILE__)
  extension = SketchupExtension.new(
    'Studio Arsitektur — Denah Bertingkat',
    'studio_architecture_floors/main'
  )
  extension.version = '1.0.0'
  extension.creator = 'Studio Arsitektur'
  extension.description = 'Kelompokkan geometri per lantai dan ekspor manifest elevasi denah.'
  Sketchup.register_extension(extension, true)
  file_loaded(__FILE__)
end
