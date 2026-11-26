require 'sketchup.rb'
require 'json'

module StudioArchitecture
  module Floors
    DICTIONARY = 'StudioArchitectureFloors'.freeze
    MANIFEST_FORMAT = 'studio-arsitektur-floor-manifest'.freeze
    MANIFEST_VERSION = 1

    def self.root_model
      model = Sketchup.active_model
      if model.active_path
        UI.messagebox('Keluar dari mode edit grup/komponen sebelum memakai alat lantai.')
        return nil
      end
      model
    end

    def self.floor_entity?(entity)
      entity.is_a?(Sketchup::Group) || entity.is_a?(Sketchup::ComponentInstance)
    end

    def self.marked_groups(model)
      groups = []
      model.entities.each do |entity|
        groups << entity if floor_entity?(entity) && entity.get_attribute(DICTIONARY, 'floor_name')
      end
      groups
    end

    def self.create_floor_group
      model = root_model
      return unless model

      selected = model.selection.to_a
      if selected.empty?
        UI.messagebox('Pilih geometri untuk satu lantai terlebih dahulu.')
        return
      end

      existing_groups = marked_groups(model)
      if existing_groups.length >= 12
        UI.messagebox('Maksimal 12 grup lantai dapat ditandai.')
        return
      end
      next_number = existing_groups.length + 1
      prompts = ['Nama lantai', 'Ketinggian bidang denah dari dasar lantai (m)']
      defaults = ["Lantai #{next_number}", '1.1']
      values = UI.inputbox(prompts, defaults, 'Kelompokkan geometri lantai')
      return unless values

      floor_name = values[0].to_s.strip
      begin
        cut_offset = Float(values[1])
      rescue ArgumentError, TypeError
        UI.messagebox('Jarak bidang denah harus berupa angka dalam meter.')
        return
      end
      if floor_name.empty? || floor_name.length > 50
        UI.messagebox('Nama lantai harus berisi 1 sampai 50 karakter.')
        return
      end
      if !cut_offset.finite? || cut_offset <= 0 || cut_offset > 10
        UI.messagebox('Jarak bidang denah harus lebih dari 0 sampai 10 meter.')
        return
      end
      if marked_groups(model).any? { |group| group.get_attribute(DICTIONARY, 'floor_name').casecmp(floor_name).zero? }
        UI.messagebox('Nama lantai tersebut sudah digunakan.')
        return
      end

      operation_started = false
      begin
        model.start_operation('Buat grup lantai', true)
        operation_started = true
        group = if selected.length == 1 && floor_entity?(selected.first)
          selected.first
        else
          model.entities.add_group(selected)
        end
        group.name = floor_name
        group.set_attribute(DICTIONARY, 'floor_name', floor_name)
        group.set_attribute(DICTIONARY, 'plan_cut_offset_m', cut_offset)
        group.set_attribute(DICTIONARY, 'base_elevation_m', group.bounds.min.z.to_m)
        model.selection.clear
        model.selection.add(group)
        model.commit_operation
        operation_started = false
        UI.messagebox(
          "#{floor_name} berhasil dikelompokkan.\n" \
          'Geometri kolom, tangga, atau dinding yang melintasi lantai sebaiknya tetap di grup terpisah.'
        )
      rescue StandardError => error
        model.abort_operation if operation_started
        UI.messagebox("Grup lantai gagal dibuat: #{error.message}")
      end
    end

    def self.set_north
      model = root_model
      return unless model

      current = model.get_attribute(DICTIONARY, 'north_degrees', 0).to_f
      values = UI.inputbox(
        ['Arah utara dari sumbu model (derajat)'],
        [current.to_s],
        'Atur arah utara proyek'
      )
      return unless values

      degrees = Float(values[0])
      unless degrees.finite? && degrees >= 0 && degrees < 360
        UI.messagebox('Arah utara harus berada di antara 0 sampai kurang dari 360 derajat.')
        return
      end

      model.set_attribute(DICTIONARY, 'north_degrees', degrees)
      UI.messagebox("Arah utara proyek disimpan: #{degrees.round(1)}°.")
    rescue ArgumentError, TypeError
      UI.messagebox('Masukkan arah utara dalam angka derajat yang valid.')
    end

    def self.export_manifest
      model = root_model
      return unless model

      groups = marked_groups(model)
      if groups.empty?
        UI.messagebox('Belum ada grup lantai. Pilih geometri dan gunakan Kelompokkan geometri lantai.')
        return
      end
      if groups.length > 12
        UI.messagebox('Maksimal 12 grup lantai dapat diekspor.')
        return
      end

      model_bounds = model.bounds
      model_min_elevation = model_bounds.min.z.to_m
      model_height = model_bounds.height.to_m
      if model_height <= 0
        UI.messagebox('Tinggi model tidak valid; periksa geometri sebelum mengekspor manifest.')
        return
      end

      floors = groups.map do |group|
        base_elevation = group.bounds.min.z.to_m
        offset = group.get_attribute(DICTIONARY, 'plan_cut_offset_m', 1.1).to_f
        plan_elevation = base_elevation + offset
        {
          'name' => group.get_attribute(DICTIONARY, 'floor_name', group.name),
          'groupName' => group.name,
          'baseElevation' => base_elevation.round(4),
          'elevation' => plan_elevation.round(4),
          'baseElevationRatio' => ((base_elevation - model_min_elevation) / model_height).round(6),
          'elevationRatio' => ((plan_elevation - model_min_elevation) / model_height).round(6)
        }
      end.sort_by { |floor| floor['baseElevation'] }
      if floors.any? { |floor| floor['elevationRatio'] <= 0 || floor['elevationRatio'] >= 1 }
        UI.messagebox('Ada bidang denah di luar tinggi model. Periksa tinggi potong setiap grup lantai.')
        return
      end
      floors.each_with_index { |floor, index| floor['index'] = index }

      manifest = {
        'format' => MANIFEST_FORMAT,
        'version' => MANIFEST_VERSION,
        'units' => 'm',
        'northDegrees' => model.get_attribute(DICTIONARY, 'north_degrees', 0).to_f,
        'floors' => floors
      }

      model_path = model.path.to_s
      directory = model_path.empty? ? Dir.home : File.dirname(model_path)
      basename = model_path.empty? ? 'proyek' : File.basename(model_path, File.extname(model_path))
      suggested_path = File.join(directory, "#{basename}.floor-manifest.json")
      output_path = UI.savepanel('Ekspor manifest denah lantai', directory, File.basename(suggested_path))
      return unless output_path

      File.open(output_path, 'w:UTF-8') { |file| file.write(JSON.pretty_generate(manifest)) }
      UI.messagebox(
        "Manifest berhasil diekspor.\n\n" \
        "Unggah GLB dan file JSON ini bersama-sama pada dashboard admin.\n" \
        'Gunakan GLTF exporter SketchUp untuk membuat file GLB.'
      )
    rescue StandardError => error
      UI.messagebox("Manifest gagal diekspor: #{error.message}")
    end

    def self.show_guide
      UI.messagebox(
        "1. Pilih geometri satu lantai di konteks model utama.\n" \
        "2. Ekstensi > Kelompokkan geometri lantai; isi nama dan tinggi potongan denah.\n" \
        "3. Ulangi untuk lantai lain. Simpan kolom/tangga yang melintasi lantai di grup terpisah.\n" \
        "4. Atur arah utara, ekspor GLB dengan GLTF exporter, lalu ekspor manifest JSON.\n" \
        '5. Unggah GLB dan manifest JSON bersama-sama di dashboard admin.'
      )
    end

    unless file_loaded?(__FILE__)
      menu = UI.menu('Extensions').add_submenu('Studio Arsitektur')
      menu.add_item('Kelompokkan geometri lantai') { create_floor_group }
      menu.add_item('Atur arah utara proyek') { set_north }
      menu.add_item('Ekspor manifest denah lantai') { export_manifest }
      menu.add_item('Panduan pengelompokan') { show_guide }
      file_loaded(__FILE__)
    end
  end
end
