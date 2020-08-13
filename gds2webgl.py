#!/usr/bin/env python3

import base64
import argparse
import colorsys

import numpy as np
import gdspy
import pyclipper
import mapbox_earcut as earcut


def collect_polys(gdslib, top, layer, datatype):
    polys = []
    scale = gdslib.unit / gdslib.precision
    flipped = 0
    for p in top.polygons:
        if p.layers[0] == layer and p.datatypes[0] == datatype:
            polys.append(p.polygons[0] * scale)
    for r in top.references:
        rpolys = r.get_polygons(by_spec=True)
        if (layer, datatype) in rpolys:
            polys += [rp * scale for rp in rpolys[(layer, datatype)]]
    for i in range(len(polys)):
        poly = polys[i]
        s = 0
        for j in range(len(poly)):
            x1, y1 = poly[j-1]
            x2, y2 = poly[j]
            s += (x2-x1)*(y2+y1)
        if s > 0:
            flipped += 1
            polys[i] = poly[::-1]
        polys[i] = np.asarray(polys[i], dtype='int32')
    return polys


def edge_normals(poly):
    normals = np.zeros((len(poly), 2))
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[i+1] if i+1 < len(poly) else poly[0]
        if y1 == y2:
            normals[i, 1] = 1 if x1 > x2 else -1
        elif x1 == x2:
            normals[i, 0] = 1 if y1 < y2 else -1
    return normals


def grow_ring(ring, factor, offset):
    normals = edge_normals(ring)
    gpoly = np.zeros((len(ring), 2), dtype='int32')
    for i in range(len(ring)):
        gpoly[i] = (ring[i] * factor).round() + (normals[i] + normals[i-1]) * offset
    return gpoly


def grow_polys(polys, factor, offset=0):
    gpolys = []
    for poly in polys:
        if type(poly) is list:
            gpoly = [grow_ring(poly[0], factor, offset)]
            for p in poly[1:]:
                gpoly.append(grow_ring(p, factor, -offset))
            gpolys.append(gpoly)
        else:
            gpolys.append(grow_ring(poly, factor, offset))
    return gpolys


def translate_polys(polys, xyoffset):
    gpolys = []
    for poly in polys:
        if type(poly) is list:
            gpolys.append([np.asarray(p + xyoffset, dtype='int32') for p in poly])
        else:
            gpolys.append(np.asarray(poly + xyoffset, dtype='int32'))
    return gpolys


def union_polys(polys):
    '''
    returns a list of lists of polygon points.
    First member of each list is an outer contour,
    the remaining members are holes.
    '''
    pc = pyclipper.Pyclipper()
    pc.AddPaths(polys, pyclipper.PT_SUBJECT, True)
    union = pc.Execute2(pyclipper.CT_UNION, pyclipper.PFT_POSITIVE, pyclipper.PFT_POSITIVE)
    
    def collect_outers_and_holes(root_node, result=None):
        if result is None:
            result = []
        for n in root_node.Childs:
            assert n.IsHole == False
            outer_and_holes = [np.asarray(n.Contour)]
            if len(n.Childs) > 0:
                for c in n.Childs:
                    assert c.IsHole
                    outer_and_holes.append(np.asarray(c.Contour))
                    if len(c.Childs) > 0:
                        collect_outers_and_holes(c, result)
            result.append(outer_and_holes)
        return result
                        
    return collect_outers_and_holes(union)


def triangulate_polys(outers_and_holes):
    points = []
    elems_top = []
    elems_north = []
    elems_south = []
    elems_east = []
    elems_west = []
    for oh in outers_and_holes:
        rings=[]
        verts=[]
        for contour in oh:
            verts += contour.tolist()
            rings.append(len(verts))
        tris = earcut.triangulate_int32(np.asarray(np.asarray(verts)*1000, dtype='int32'), np.asarray(rings, dtype='int32'))
        offset = len(points) * 2
        elems_top += list(tris * 2 + offset);
        outer = oh[0]
        for i in range(len(outer)):
            i2 = i+1
            if i2 == len(outer):
                i2 = 0
            p1 = outer[i]
            p2 = outer[i2]
            elems = [ offset + i*2, offset + i*2 + 1, offset + i2*2, 
                    offset + i2*2, offset + i*2 + 1, offset + i2*2 + 1 ]
            if p1[1] == p2[1]:
                if p1[0] > p2[0]:
                    elems_north += elems
                else:
                    elems_south += elems
            elif p1[0] == p2[0]:
                if p1[1] > p2[1]:
                    elems_west += elems
                else:
                    elems_east += elems
        # TODO: holes
        
        points += verts
        
    points = np.asarray(points).flatten()
    elems_top = np.asarray(elems_top, dtype='int32')
    elems_north = np.asarray(elems_north, dtype='int32')
    elems_south = np.asarray(elems_south, dtype='int32')
    elems_east = np.asarray(elems_east, dtype='int32')
    elems_west = np.asarray(elems_west, dtype='int32')
    return points, elems_top, elems_north, elems_south, elems_east, elems_west


def rgba2js(rgba):
    return '[' + ', '.join([f'{((rgba >> s) & 0xff) / 255:.3f}' for s in [24, 16, 8, 0]]) + ']'


def write_layer(f, gdslib, topcell, scale, origin, layer, datatype, hsv, z_um, depth_um):
    print(f'Layer {layer}/{datatype}')
    polys = collect_polys(gdslib, topcell, layer, datatype)
    print(f'  GDS2PolygonCount {len(polys)}')
    va = np.asarray([])
    elems_top = np.asarray([], dtype='int32')
    elems_north = np.asarray([], dtype='int32')
    elems_south = np.asarray([], dtype='int32')
    elems_east = np.asarray([], dtype='int32')
    elems_west = np.asarray([], dtype='int32')
    if len(polys) > 0:
        gpolys = grow_polys(polys, 10, 1)
        uupolys = union_polys(gpolys)
        uupolys = grow_polys(uupolys, 0.1)
        upolys = translate_polys(uupolys, -origin_um * gdslib.unit / gdslib.precision )
        print(f'  UnionPolygonCount Contours {len(upolys)} Holes {sum([len(ch)-1 for ch in upolys])}')
        va, elems_top, elems_north, elems_south, elems_east, elems_west = triangulate_polys(upolys)

    va = np.asarray((va * scale * gdslib.precision / gdslib.unit * (2**16-1)), dtype='uint16')

    print(f'  VertexCount {len(va)//2}')
    print(f'  TopTriangleCount {len(elems_top)//3}')
    
    f.write(f"{{ layer: '{layer}/{datatype}',\n")
    f.write(f"  z_top: {z_um*scale},\n")
    f.write(f"  depth: {depth_um*scale},\n")
    f.write(f"  color: {list(colorsys.hsv_to_rgb(*hsv)) + [1.0]},\n")
    f.write(f"  p_len: {len(va)//2},\n")
    f.write(f"  p_str: '"+base64.b64encode(va).decode('utf-8')+"',\n")
    f.write(f"  t_len: {len(elems_top)},\n")
    f.write(f"  t_str: '"+base64.b64encode(elems_top).decode('utf-8')+"',\n")
    if depth_um > 0:
        f.write(f"  n_len: {len(elems_north)},\n")
        f.write(f"  n_str: '"+base64.b64encode(elems_north).decode('utf-8')+"',\n")
        f.write(f"  s_len: {len(elems_south)},\n")
        f.write(f"  s_str: '"+base64.b64encode(elems_south).decode('utf-8')+"',\n")
        f.write(f"  e_len: {len(elems_east)},\n")
        f.write(f"  e_str: '"+base64.b64encode(elems_east).decode('utf-8')+"',\n")
        f.write(f"  w_len: {len(elems_west)},\n")
        f.write(f"  w_str: '"+base64.b64encode(elems_west).decode('utf-8')+"',\n")
    f.write(f"}},\n")
    return scale


def write_data(f, gdslib, topcell, scale, origin, size):
    f.write(f"data_scale = {scale};\n")
    f.write(f"data_size = [{size[0]*scale}, {size[1]*scale}];\n")
    f.write("data = [\n")
    write_layer(f, gdslib, topcell, scale, origin, 235, 4, (0/3, 0.7, 0.35), 0.0, 0.0) # p-substrate
    write_layer(f, gdslib, topcell, scale, origin, 64, 20, (2/3, 0.7, 0.35), 0.0, 0.0) # n-well
    write_layer(f, gdslib, topcell, scale, origin, 65, 20, (2/3, 0.0, 0.15), 0.0, 0.0) # diffusion (opposite type)
    write_layer(f, gdslib, topcell, scale, origin, 65, 44, (2/3, 0.0, 0.15), 0.0, 0.0) # tap (same type)

    write_layer(f, gdslib, topcell, scale, origin, 66, 20, (1.5/3, 0.55, 0.25), 0.5, 0.4) # poly

    write_layer(f, gdslib, topcell, scale, origin, 64, 16, (0.4/3, 0.65, 0.3), 0.94, 0.94) # nwell.pin
    write_layer(f, gdslib, topcell, scale, origin, 122, 16, (0.4/3, 0.65, 0.3), 0.94, 0.94) # pwell.pin
    write_layer(f, gdslib, topcell, scale, origin, 66, 44, (0.4/3, 0.65, 0.3), 0.94, 0.94) # licon
    write_layer(f, gdslib, topcell, scale, origin, 67, 20, (0.4/3, 0.65, 0.3), 1.011, 0.1) # li

    write_layer(f, gdslib, topcell, scale, origin, 67, 44, (1/3, 0.8, 0.45), 1.38, 0.38) # mcon
    write_layer(f, gdslib, topcell, scale, origin, 68, 20, (1/3, 0.8, 0.45), 1.38+0.36, 0.36) # m1
    
    write_layer(f, gdslib, topcell, scale, origin, 68, 44, (1/3, 0.8, 0.6), 2.0, 0.27) # via
    write_layer(f, gdslib, topcell, scale, origin, 69, 20, (1/3, 0.8, 0.6), 2.0+0.36, 0.36) # m2
    
    write_layer(f, gdslib, topcell, scale, origin, 69, 44, (1/3, 0.8, 0.7), 2.79, 0.42) # via2
    write_layer(f, gdslib, topcell, scale, origin, 70, 20, (1/3, 0.8, 0.7), 2.79+0.85, 0.85) # m3
    
    write_layer(f, gdslib, topcell, scale, origin, 70, 44, (1/3, 0.8, 0.8), 4.02, 0.39) # via3
    write_layer(f, gdslib, topcell, scale, origin, 71, 20, (1/3, 0.8, 0.8), 4.02+0.85, 0.85) # m4
    
    write_layer(f, gdslib, topcell, scale, origin, 71, 44, (1/3, 0.8, 0.9), 5.37, 0.51) # via4
    write_layer(f, gdslib, topcell, scale, origin, 72, 20, (1/3, 0.8, 0.9), 5.37+1.26, 1.26) # m5
    
    f.write("];\n")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Translate GDSII to WebGL for visualization.')
    parser.add_argument('-i', '--input', required=True, help='Input GDSII file.')
    parser.add_argument('-o', '--output', required=True, help='Output file. "<file>.html" outputs a self-contained webpage, "<file>.js" outputs 3D data as Javascript.')
    args = parser.parse_args()
    if args.output.endswith('.html'):
        print(f'Reading index.html')
        with open('index.html', 'r') as f:
            index_html = f.readlines()
        print(f'Reading bundle.js')
        with open('bundle.js', 'r') as f:
            bundle_js = f.readlines()
    print(f'Loading {args.input}')
    gdslib = gdspy.GdsLibrary(infile=args.input)
    topcell = gdslib.top_level()[0]
    print(f'Top {topcell.name}')
    bbox = topcell.get_bounding_box()
    origin_um = bbox[0]*gdslib.unit*1e6
    max_um = bbox[1]*gdslib.unit*1e6
    size_um = max_um-origin_um
    print(f'PhysicalSize {size_um[0]:.3f} x {size_um[1]:.3f} µm')
    scale = 1.0/max(size_um)
    print(f'ScalingFactor {scale:.3e}')
    print(f'ModelSize {size_um[0]*scale:.3f} x {size_um[1]*scale:.3f}')
    
    with open(args.output, 'w') as f:
        if args.output.endswith('.html'):
            for l in index_html:
                l = l.replace('</title>', f' - {args.input}</title>')
                if '<script src="data.js"></script>' in l:
                    f.write('<script>\n')
                    write_data(f, gdslib, topcell, scale, origin_um, size_um)
                    f.write('</script>\n')
                elif '<script src="bundle.js"></script>' in l:
                    f.write('<script>\n')
                    for ll in bundle_js:
                        f.write(ll)
                    f.write('</script>\n')
                else:
                    f.write(l)
        else:
            write_data(f, gdslib, topcell, scale, origin_um, size_um)

